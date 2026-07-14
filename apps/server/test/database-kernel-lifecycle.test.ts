import { strict as assert } from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import {
  createDatabaseProvider,
  type DatabaseProvider,
} from '../src/persistence/database-provider';
import { sessions } from '../src/persistence/schema';
import {
  type DaemonApplication,
  startDaemon,
} from '../src/runtime/daemon-lifecycle';

class LifecycleApplication implements DaemonApplication {
  readonly #closeCallbacks: Array<() => Promise<void>> = [];

  async listen(): Promise<void> {}

  onClose(callback: () => Promise<void>): void {
    this.#closeCallbacks.push(callback);
  }

  async close(): Promise<void> {
    for (const callback of this.#closeCallbacks) await callback();
  }
}

async function startKernel(databasePath: string): Promise<{
  application: DaemonApplication;
  provider: DatabaseProvider;
}> {
  let provider: DatabaseProvider | undefined;
  const application = await startDaemon({
    databasePath,
    createProvider: createDatabaseProvider,
    createApplication: async (_resolvedPath, receivedProvider) => {
      assert.ok(receivedProvider);
      provider = receivedProvider;
      return new LifecycleApplication();
    },
  });
  assert.ok(provider);
  return { application, provider };
}

test('real daemon kernel migrates, writes with its Clock, rolls back, closes, and restarts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'colorful-code-kernel-'));
  const databasePath = join(directory, 'database.sqlite');

  try {
    const first = await startKernel(databasePath);
    const committedAt = await first.provider.transaction((transaction) => {
      transaction.database.db
        .insert(sessions)
        .values({
          id: 'committed',
          snapshot: '{}',
          updatedAt: transaction.now,
        })
        .run();
      return transaction.now;
    });
    assert.equal(Number.isSafeInteger(committedAt), true);

    const transactionError = new Error('roll back row and timestamp');
    await assert.rejects(
      first.provider.transaction((transaction) => {
        transaction.database.db
          .insert(sessions)
          .values({
            id: 'rolled-back',
            snapshot: '{}',
            updatedAt: transaction.now,
          })
          .run();
        throw transactionError;
      }),
      (error) => error === transactionError,
    );
    assert.equal(
      first.provider.read(
        ({ db }) =>
          db
            .select({ id: sessions.id })
            .from(sessions)
            .where(eq(sessions.id, 'rolled-back'))
            .all().length,
      ),
      0,
    );

    await first.application.close();
    assert.throws(() => first.provider.transaction(() => undefined));

    const restarted = await startKernel(databasePath);
    assert.deepEqual(
      restarted.provider.read(({ db }) =>
        db
          .select({ id: sessions.id, updatedAt: sessions.updatedAt })
          .from(sessions)
          .where(eq(sessions.id, 'committed'))
          .all(),
      ),
      [{ id: 'committed', updatedAt: committedAt }],
    );
    await restarted.application.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('application initialization failure closes Provider and releases the real lock', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'colorful-code-kernel-fail-'));
  const databasePath = join(directory, 'database.sqlite');
  let failedProvider: DatabaseProvider | undefined;

  try {
    await assert.rejects(
      startDaemon({
        databasePath,
        createProvider: (path) => {
          failedProvider = createDatabaseProvider(path);
          return failedProvider;
        },
        createApplication: async () => {
          throw new Error('injected application initialization failure');
        },
      }),
      /injected application initialization failure/,
    );
    assert.ok(failedProvider);
    assert.throws(() => failedProvider.read(() => undefined));

    const restarted = await startKernel(databasePath);
    await restarted.application.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
