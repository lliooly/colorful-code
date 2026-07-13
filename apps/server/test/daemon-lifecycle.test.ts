import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import {
  DataDirectoryInstanceLock,
  DataDirectoryLockConflictError,
} from '../src/runtime/data-directory-instance-lock';
import {
  type DaemonApplication,
  startDaemon,
} from '../src/runtime/daemon-lifecycle';

class FakeApplication implements DaemonApplication {
  closeCallbacks: Array<() => Promise<void>> = [];
  closeCalls = 0;
  listenCalls = 0;

  constructor(
    private readonly options: {
      events?: string[];
      listenError?: Error;
      closeError?: Error;
      runCallbacksOnClose?: boolean;
    } = {},
  ) {}

  onClose(callback: () => Promise<void>): void {
    this.options.events?.push('register-close');
    this.closeCallbacks.push(callback);
  }

  async listen(): Promise<void> {
    this.listenCalls += 1;
    this.options.events?.push('listen');
    if (this.options.listenError) throw this.options.listenError;
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
    this.options.events?.push('close-app');
    const errors: unknown[] = [];
    if (this.options.runCallbacksOnClose) {
      for (const callback of this.closeCallbacks) {
        try {
          await callback();
        } catch (error) {
          errors.push(error);
        }
      }
    }
    if (this.options.closeError) errors.unshift(this.options.closeError);
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, 'close failed');
  }
}

test('acquires the data-directory lock before creating or listening to the app', async () => {
  const events: string[] = [];
  let locked = false;
  const application = new FakeApplication({ events });

  await startDaemon({
    databasePath: './relative/data.sqlite',
    acquireLock: async (dataDirectory) => {
      assert.equal(dataDirectory, dirname(resolve('./relative/data.sqlite')));
      events.push('acquire-lock');
      locked = true;
      return { release: async () => undefined };
    },
    createApplication: async () => {
      assert.equal(locked, true);
      events.push('create-app');
      return application;
    },
  });

  assert.deepEqual(events, [
    'acquire-lock',
    'create-app',
    'register-close',
    'listen',
  ]);
});

test('a lock conflict prevents app creation and startup without releasing an unowned lock', async () => {
  let createCalls = 0;
  let releaseCalls = 0;
  const application = new FakeApplication();
  const conflict = new DataDirectoryLockConflictError('/occupied');

  await assert.rejects(
    startDaemon({
      databasePath: '/occupied/data.sqlite',
      acquireLock: async () => {
        throw conflict;
      },
      createApplication: async () => {
        createCalls += 1;
        return application;
      },
    }),
    (error) => error === conflict,
  );

  assert.equal(createCalls, 0);
  assert.equal(application.listenCalls, 0);
  assert.equal(releaseCalls, 0);
});

test('releases the lock once and preserves an application creation error', async () => {
  const creationError = new Error('create failed');
  let releaseCalls = 0;

  await assert.rejects(
    startDaemon({
      databasePath: '/data/db.sqlite',
      acquireLock: async () => ({
        release: async () => {
          releaseCalls += 1;
        },
      }),
      createApplication: async () => {
        throw creationError;
      },
    }),
    (error) => error === creationError,
  );

  assert.equal(releaseCalls, 1);
});

test('releases the real data-directory lock when application creation fails', async () => {
  const dataDirectory = mkdtempSync(
    join(tmpdir(), 'colorful-code-create-failure-'),
  );
  const creationError = new Error('Nest initialization failed');

  try {
    await assert.rejects(
      startDaemon({
        databasePath: join(dataDirectory, 'data.sqlite'),
        createApplication: async () => {
          throw creationError;
        },
      }),
      (error) => error === creationError,
    );

    const nextLock = await DataDirectoryInstanceLock.acquire(dataDirectory);
    await nextLock.release();
  } finally {
    rmSync(dataDirectory, { recursive: true, force: true });
  }
});

test('a listen failure closes the app before directly releasing its lock', async () => {
  const events: string[] = [];
  const listenError = new Error('listen failed');
  let releaseCalls = 0;
  const application = new FakeApplication({ events, listenError });

  await assert.rejects(
    startDaemon({
      databasePath: '/data/db.sqlite',
      acquireLock: async () => ({
        release: async () => {
          releaseCalls += 1;
          events.push('release-lock');
        },
      }),
      createApplication: async () => application,
    }),
    (error) => error === listenError,
  );

  assert.equal(application.closeCallbacks.length, 1);
  assert.deepEqual(events.slice(-2), ['close-app', 'release-lock']);
  assert.equal(releaseCalls, 1);
});

test('normal app close runs the registered callback and repeated release is safe', async () => {
  let physicalReleases = 0;
  let released = false;
  const lock = {
    release: async () => {
      if (released) return;
      released = true;
      physicalReleases += 1;
    },
  };
  const application = new FakeApplication({ runCallbacksOnClose: true });

  await startDaemon({
    databasePath: '/data/db.sqlite',
    acquireLock: async () => lock,
    createApplication: async () => application,
  });
  await application.close();
  await application.close();
  await lock.release();

  assert.equal(physicalReleases, 1);
});

test('aggregates a startup error with both app-close and lock-release failures', async () => {
  const listenError = new Error('listen failed');
  const closeError = new Error('close failed');
  const releaseError = new Error('release failed');
  const application = new FakeApplication({ listenError, closeError });

  await assert.rejects(
    startDaemon({
      databasePath: '/data/db.sqlite',
      acquireLock: async () => ({
        release: async () => {
          throw releaseError;
        },
      }),
      createApplication: async () => application,
    }),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [listenError, closeError, releaseError]);
      return true;
    },
  );
});

test('aggregates an app creation error with lock-release failure', async () => {
  const creationError = new Error('create failed');
  const releaseError = new Error('release failed');

  await assert.rejects(
    startDaemon({
      databasePath: '/data/db.sqlite',
      acquireLock: async () => ({
        release: async () => {
          throw releaseError;
        },
      }),
      createApplication: async () => {
        throw creationError;
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [creationError, releaseError]);
      return true;
    },
  );
});

test('aggregates a startup error with an app-close failure when lock release succeeds', async () => {
  const listenError = new Error('listen failed');
  const closeError = new Error('close failed');
  const application = new FakeApplication({ listenError, closeError });

  await assert.rejects(
    startDaemon({
      databasePath: '/data/db.sqlite',
      acquireLock: async () => ({ release: async () => undefined }),
      createApplication: async () => application,
    }),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [listenError, closeError]);
      return true;
    },
  );
});

for (const databasePath of [
  ':memory:',
  '',
  'file::memory:',
  'file::memory:?cache=shared',
]) {
  test(`does not acquire a filesystem lock for in-memory path ${JSON.stringify(databasePath)}`, async () => {
    let acquireCalls = 0;
    const application = new FakeApplication();

    const result = await startDaemon({
      databasePath,
      acquireLock: async () => {
        acquireCalls += 1;
        return { release: async () => undefined };
      },
      createApplication: async () => application,
    });

    assert.equal(result, application);
    assert.equal(acquireCalls, 0);
    assert.equal(application.listenCalls, 1);
  });
}
