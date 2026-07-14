import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Database } from 'bun:sqlite';
import { sql } from 'drizzle-orm';
import {
  FixedDatabaseClock,
  SqliteDatabaseClock,
  type DatabaseClock,
} from '../src/persistence/database-clock';
import {
  AsyncTransactionCallbackError,
  DatabaseBusyRetryExhaustedError,
  DatabaseFacadeRevokedError,
  DatabaseProviderClosedError,
  DatabaseProviderOwnershipError,
  DatabaseProviderPathError,
  DatabaseReadOnlyError,
  NestedTransactionError,
  createDatabaseProvider,
} from '../src/persistence/database-provider';
import { createTestDatabaseProvider } from './support/database-provider-testing';
import { bootstrapMigrations } from '../src/persistence/migration-bootstrap';
import { sessions } from '../src/persistence/schema';
import { configureSqliteConnection } from '../src/persistence/sqlite-configuration';

async function withTempDirectory<T>(
  body: (directory: string) => T | Promise<T>,
): Promise<T> {
  const directory = mkdtempSync(join(tmpdir(), 'colorful-code-provider-'));
  try {
    await bootstrapMigrations(join(directory, 'database.sqlite'));
    return await body(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function createGate(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
} {
  let resolveGate!: () => void;
  const promise = new Promise<void>((resolve) => {
    resolveGate = resolve;
  });
  return { promise, resolve: resolveGate };
}

test('uses the migrated schema and applies production SQLite policy before reads', async () => {
  await withTempDirectory(async (directory) => {
    let raw: Database | undefined;
    const provider = createTestDatabaseProvider(
      join(directory, 'database.sqlite'),
      {
        connectionFactory: (databasePath) => {
          raw = new Database(databasePath);
          return raw;
        },
      },
    );
    try {
      const rows = provider.read((connection) =>
        connection.db.select().from(sessions).all(),
      );
      assert.ok(raw);
      const journalMode = raw
        .query<{ journal_mode: string }, []>('PRAGMA journal_mode')
        .get();
      const foreignKeys = raw
        .query<{ foreign_keys: number }, []>('PRAGMA foreign_keys')
        .get();
      const busyTimeout = raw
        .query<{ timeout: number }, []>('PRAGMA busy_timeout')
        .get();
      const synchronous = raw
        .query<{ synchronous: number }, []>('PRAGMA synchronous')
        .get();
      const tempStore = raw
        .query<{ temp_store: number }, []>('PRAGMA temp_store')
        .get();
      const trustedSchema = raw
        .query<{ trusted_schema: number }, []>('PRAGMA trusted_schema')
        .get();
      const queryOnly = raw
        .query<{ query_only: number }, []>('PRAGMA query_only')
        .get();

      assert.deepEqual(rows, []);
      assert.equal(journalMode?.journal_mode.toLowerCase(), 'wal');
      assert.equal(foreignKeys?.foreign_keys, 1);
      assert.equal(busyTimeout?.timeout, 250);
      assert.equal(synchronous?.synchronous, 2);
      assert.equal(tempStore?.temp_store, 2);
      assert.equal(trustedSchema?.trusted_schema, 0);
      assert.equal(queryOnly?.query_only, 0);
      assert.equal(
        (provider as typeof provider & { accessMode?: unknown }).accessMode,
        'read-write',
      );
      const diagnostics = (
        provider as typeof provider & {
          diagnostics?: {
            connectionRole?: unknown;
            journalMode?: unknown;
            foreignKeys?: unknown;
          };
        }
      ).diagnostics;
      assert.deepEqual(
        diagnostics && {
          connectionRole: diagnostics.connectionRole,
          journalMode: diagnostics.journalMode,
          foreignKeys: diagnostics.foreignKeys,
        },
        {
          connectionRole: 'business-read-write',
          journalMode: 'wal',
          foreignKeys: true,
        },
      );
      assert.equal(Object.isFrozen(diagnostics), true);
    } finally {
      await provider.close();
    }
  });
});

test('production Provider options cannot replace the SQLite policy', async () => {
  await withTempDirectory(async (directory) => {
    let attemptedOverrideCalls = 0;
    const provider = createDatabaseProvider(
      join(directory, 'database.sqlite'),
      {
        accessMode: 'read-write',
        configureConnection: () => {
          attemptedOverrideCalls += 1;
          throw new Error('must not run');
        },
      } as Parameters<typeof createDatabaseProvider>[1] & {
        configureConnection: () => never;
      },
    );
    try {
      assert.equal(attemptedOverrideCalls, 0);
      assert.equal(provider.diagnostics.connectionRole, 'business-read-write');
    } finally {
      await provider.close();
    }
  });
});

test('rejects reads and clock queries once closing has started', async () => {
  await withTempDirectory(async (directory) => {
    const provider = createDatabaseProvider(join(directory, 'database.sqlite'));
    await provider.close();

    assert.throws(
      () => provider.read(() => undefined),
      DatabaseProviderClosedError,
    );
    assert.throws(
      () => provider.read((connection) => provider.clock.now(connection)),
      DatabaseProviderClosedError,
    );
  });
});

test('restart exposes equivalent frozen diagnostics', async () => {
  await withTempDirectory(async (directory) => {
    const databasePath = join(directory, 'database.sqlite');
    const first = createDatabaseProvider(databasePath);
    const firstDiagnostics = first.diagnostics;
    await first.close();

    const second = createDatabaseProvider(databasePath);
    try {
      assert.deepEqual(second.diagnostics, firstDiagnostics);
      assert.notEqual(second.diagnostics, firstDiagnostics);
      assert.equal(Object.isFrozen(second.diagnostics), true);
      assert.equal(Object.isFrozen(second.diagnostics.compileOptions), true);
    } finally {
      await second.close();
    }
  });
});

test('read-only Provider requires an existing WAL database and rejects transactions synchronously', async () => {
  await withTempDirectory(async (directory) => {
    const missingPath = join(directory, 'missing.sqlite');
    assert.throws(() =>
      createDatabaseProvider(missingPath, { accessMode: 'read-only' }),
    );

    const nonWalPath = join(directory, 'non-wal.sqlite');
    const nonWal = new Database(nonWalPath);
    nonWal.exec('CREATE TABLE probe (id INTEGER)');
    nonWal.close();
    assert.throws(() =>
      createDatabaseProvider(nonWalPath, { accessMode: 'read-only' }),
    );

    const databasePath = join(directory, 'database.sqlite');
    const writer = createDatabaseProvider(databasePath);
    await writer.transaction((transaction) => {
      transaction.database.db
        .insert(sessions)
        .values({ id: 'readonly', snapshot: '{}', updatedAt: transaction.now })
        .run();
    });
    await writer.close();

    const reader = createTestDatabaseProvider(databasePath, {
      accessMode: 'read-only',
    });
    try {
      assert.equal(reader.accessMode, 'read-only');
      assert.equal(reader.diagnostics.connectionRole, 'business-read-only');
      assert.equal(
        reader.read((connection) => connection.db.select().from(sessions).all())
          .length,
        1,
      );
      let callbackCalls = 0;
      assert.throws(
        () =>
          reader.transaction(() => {
            callbackCalls += 1;
          }),
        DatabaseReadOnlyError,
      );
      assert.equal(callbackCalls, 0);
    } finally {
      await reader.close();
    }
  });
});

test('close called inside read waits for the read lease before physical close', async () => {
  await withTempDirectory(async (directory) => {
    const events: string[] = [];
    let closePromise: Promise<void> | undefined;
    const provider = createTestDatabaseProvider(
      join(directory, 'database.sqlite'),
      {
        checkpointWal: () => {
          events.push('checkpoint');
          return Object.freeze({
            status: 'completed',
            sqliteBusy: false,
            logFrames: 0,
            checkpointedFrames: 0,
            remainingFrames: 0,
          });
        },
        closeConnection: (connection) => {
          events.push('physical-close');
          connection.close();
        },
      },
    );

    provider.read((connection) => {
      events.push('read-start');
      closePromise = provider.close();
      assert.equal(provider.close(), closePromise);
      assert.deepEqual(connection.db.select().from(sessions).all(), []);
      events.push('read-end');
      assert.deepEqual(events, ['read-start', 'read-end']);
    });
    assert.ok(closePromise);
    await closePromise;
    assert.deepEqual(events, [
      'read-start',
      'read-end',
      'checkpoint',
      'physical-close',
    ]);
  });
});

test('close called by the transaction clock and callback allows the current commit', async () => {
  await withTempDirectory(async (directory) => {
    const databasePath = join(directory, 'database.sqlite');
    let closePromise: Promise<void> | undefined;
    const provider = createTestDatabaseProvider(databasePath, {
      clock: {
        now: () => {
          closePromise = provider.close();
          return 123;
        },
      },
    });

    const result = await provider.transaction((transaction) => {
      assert.equal(provider.close(), closePromise);
      transaction.database.db
        .insert(sessions)
        .values({ id: 'committed', snapshot: '{}', updatedAt: transaction.now })
        .run();
      return 'committed';
    });
    assert.equal(result, 'committed');
    assert.ok(closePromise);
    await closePromise;

    const reopened = createDatabaseProvider(databasePath);
    try {
      assert.equal(
        reopened.read((connection) =>
          connection.db.select().from(sessions).all(),
        ).length,
        1,
      );
    } finally {
      await reopened.close();
    }
  });
});

test('close first called inside a transaction callback allows commit before close', async () => {
  await withTempDirectory(async (directory) => {
    const databasePath = join(directory, 'database.sqlite');
    const provider = createTestDatabaseProvider(databasePath, {
      clock: new FixedDatabaseClock(456),
    });
    let closePromise: Promise<void> | undefined;
    const result = await provider.transaction((transaction) => {
      closePromise = provider.close();
      transaction.database.db
        .insert(sessions)
        .values({
          id: 'callback-close',
          snapshot: '{}',
          updatedAt: transaction.now,
        })
        .run();
      return 'committed';
    });
    assert.equal(result, 'committed');
    assert.ok(closePromise);
    await closePromise;

    const reopened = createDatabaseProvider(databasePath);
    try {
      assert.equal(
        reopened.read((connection) =>
          connection.db.select().from(sessions).all(),
        )[0]?.id,
        'callback-close',
      );
    } finally {
      await reopened.close();
    }
  });
});

test('transaction remains active during retry sleep and close prevents another BEGIN', async () => {
  await withTempDirectory(async (directory) => {
    const sleepEntered = createGate();
    const releaseSleep = createGate();
    let beginCalls = 0;
    const busy = Object.assign(new Error('busy'), { code: 'SQLITE_BUSY' });
    const provider = createTestDatabaseProvider(
      join(directory, 'database.sqlite'),
      {
        executeTransactionControl: (connection, statement) => {
          if (statement === 'BEGIN IMMEDIATE') {
            beginCalls += 1;
            throw busy;
          }
          connection.exec(statement);
        },
        sleep: async () => {
          sleepEntered.resolve();
          await releaseSleep.promise;
        },
      },
    );
    const transactionPromise = provider.transaction(() => undefined, {
      retry: {
        maxRetries: 1,
        baseDelayMs: 0,
        maxDelayMs: 0,
        jitterRatio: 0,
      },
    });
    await sleepEntered.promise;
    assert.throws(
      () => provider.transaction(() => undefined),
      NestedTransactionError,
    );
    const closePromise = provider.close();
    releaseSleep.resolve();
    await assert.rejects(transactionPromise, DatabaseProviderClosedError);
    await closePromise;
    assert.equal(beginCalls, 1);
  });
});

test('close requested by a busy transaction prevents retry and preserves callback-at-most-once', async () => {
  await withTempDirectory(async (directory) => {
    let closePromise: Promise<void> | undefined;
    let beginCalls = 0;
    let callbackCalls = 0;
    let sleepCalls = 0;
    const provider = createTestDatabaseProvider(
      join(directory, 'database.sqlite'),
      {
        executeTransactionControl: (connection, statement) => {
          if (statement === 'BEGIN IMMEDIATE') beginCalls += 1;
          connection.exec(statement);
        },
        sleep: async () => {
          sleepCalls += 1;
        },
      },
    );

    const transactionPromise = provider.transaction(
      () => {
        callbackCalls += 1;
        closePromise = provider.close();
        throw Object.assign(new Error('busy'), { code: 'SQLITE_BUSY' });
      },
      {
        retry: {
          maxRetries: 1,
          baseDelayMs: 0,
          maxDelayMs: 0,
          jitterRatio: 0,
        },
      },
    );
    await assert.rejects(
      transactionPromise,
      (error: unknown) =>
        typeof error === 'object' &&
        error !== null &&
        (error as { code?: unknown }).code === 'SQLITE_BUSY',
    );
    assert.ok(closePromise);
    await closePromise;
    assert.equal(beginCalls, 1);
    assert.equal(callbackCalls, 1);
    assert.equal(sleepCalls, 0);
  });
});

test('close is idempotent and closes the physical connection exactly once', async () => {
  await withTempDirectory(async (directory) => {
    let closeCount = 0;
    const provider = createTestDatabaseProvider(
      join(directory, 'database.sqlite'),
      {
        closeConnection: (connection) => {
          closeCount += 1;
          connection.close();
        },
      },
    );

    await Promise.all([provider.close(), provider.close(), provider.close()]);
    await provider.close();
    assert.equal(closeCount, 1);
    assert.equal(provider.lastCheckpointResult?.status, 'completed');
  });
});

test('close records an incomplete checkpoint and still closes and releases ownership', async () => {
  await withTempDirectory(async (directory) => {
    const databasePath = join(directory, 'database.sqlite');
    const incomplete = Object.freeze({
      status: 'incomplete' as const,
      sqliteBusy: false,
      logFrames: 3,
      checkpointedFrames: 1,
      remainingFrames: 2,
    });
    let closeCalls = 0;
    const provider = createTestDatabaseProvider(databasePath, {
      checkpointWal: () => incomplete,
      closeConnection: (connection) => {
        closeCalls += 1;
        connection.close();
      },
    });

    await provider.close();
    assert.equal(provider.lastCheckpointResult, incomplete);
    assert.equal(closeCalls, 1);
    const reopened = createDatabaseProvider(databasePath);
    await reopened.close();
  });
});

test('close records an interrupted checkpoint and still completes shutdown', async () => {
  await withTempDirectory(async (directory) => {
    const provider = createDatabaseProvider(join(directory, 'database.sqlite'));
    const controller = new AbortController();

    const closePromise = provider.close({
      checkpointSignal: controller.signal,
    });
    controller.abort();
    await closePromise;
    assert.deepEqual(provider.lastCheckpointResult, {
      status: 'interrupted',
      sqliteBusy: false,
      logFrames: 0,
      checkpointedFrames: 0,
      remainingFrames: 0,
    });
    assert.throws(
      () => provider.read(() => undefined),
      DatabaseProviderClosedError,
    );
  });
});

test('checkpoint failure still closes, releases ownership, and preserves the original error', async () => {
  await withTempDirectory(async (directory) => {
    const databasePath = join(directory, 'database.sqlite');
    const checkpointError = new Error('checkpoint failed');
    let closeCalls = 0;
    const provider = createTestDatabaseProvider(databasePath, {
      checkpointWal: () => {
        throw checkpointError;
      },
      closeConnection: (connection) => {
        closeCalls += 1;
        connection.close();
      },
    });

    await assert.rejects(
      provider.close(),
      (error) => error === checkpointError,
    );
    assert.equal(closeCalls, 1);
    assert.equal(provider.lastCheckpointResult, undefined);
    assert.throws(
      () => provider.read(() => undefined),
      DatabaseProviderClosedError,
    );
    const reopened = createDatabaseProvider(databasePath);
    await reopened.close();
  });
});

test('close aggregates checkpoint and physical close errors without releasing ownership', async () => {
  await withTempDirectory(async (directory) => {
    const checkpointError = new Error('checkpoint failed');
    const closeError = new Error('close failed');
    const databasePath = join(directory, 'database.sqlite');
    let raw: Database | undefined;
    let releaseCalls = 0;
    const provider = createTestDatabaseProvider(databasePath, {
      connectionFactory: (path) => {
        raw = new Database(path);
        return raw;
      },
      checkpointWal: () => {
        throw checkpointError;
      },
      closeConnection: () => {
        throw closeError;
      },
      releaseOwnership: () => {
        releaseCalls += 1;
      },
    });

    try {
      await assert.rejects(provider.close(), (error) => {
        assert.ok(error instanceof AggregateError);
        assert.deepEqual(error.errors, [checkpointError, closeError]);
        return true;
      });
      assert.equal(releaseCalls, 0);
      assert.throws(
        () => createDatabaseProvider(databasePath),
        DatabaseProviderOwnershipError,
      );
    } finally {
      raw?.close();
    }
  });
});

test('close aggregates checkpoint and ownership release failures after physical close', async () => {
  await withTempDirectory(async (directory) => {
    const checkpointError = new Error('checkpoint failed');
    const ownershipError = new Error('ownership failed');
    const provider = createTestDatabaseProvider(
      join(directory, 'database.sqlite'),
      {
        checkpointWal: () => {
          throw checkpointError;
        },
        releaseOwnership: () => {
          throw ownershipError;
        },
      },
    );

    await assert.rejects(provider.close(), (error) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [checkpointError, ownershipError]);
      return true;
    });
    assert.throws(
      () => provider.read(() => undefined),
      DatabaseProviderClosedError,
    );
  });
});

test('an ownership release failure is returned unchanged after physical close', async () => {
  await withTempDirectory(async (directory) => {
    const ownershipError = new Error('ownership failed');
    const provider = createTestDatabaseProvider(
      join(directory, 'database.sqlite'),
      {
        releaseOwnership: () => {
          throw ownershipError;
        },
      },
    );

    await assert.rejects(provider.close(), (error) => error === ownershipError);
    assert.throws(
      () => provider.read(() => undefined),
      DatabaseProviderClosedError,
    );
  });
});

test('a failed physical close keeps ownership and returns the same failure', async () => {
  await withTempDirectory(async (directory) => {
    const databasePath = join(directory, 'database.sqlite');
    const closeError = new Error('close failed');
    let raw: Database | undefined;
    const provider = createTestDatabaseProvider(databasePath, {
      connectionFactory: (path) => {
        raw = new Database(path);
        return raw;
      },
      closeConnection: () => {
        throw closeError;
      },
    });

    try {
      await assert.rejects(provider.close(), (error) => error === closeError);
      await assert.rejects(provider.close(), (error) => error === closeError);
      assert.throws(
        () => createDatabaseProvider(databasePath),
        DatabaseProviderOwnershipError,
      );
      assert.throws(
        () => provider.read(() => undefined),
        DatabaseProviderClosedError,
      );
    } finally {
      raw?.close();
    }
  });
});

test('owns a normalized data directory until close and allows other directories', async () => {
  await withTempDirectory(async (directory) => {
    const firstPath = join(directory, 'nested', '..', 'first.sqlite');
    const sameDirectoryPath = join(directory, 'second.sqlite');
    const otherDirectoryPath = join(directory, 'other', 'database.sqlite');
    const first = createDatabaseProvider(firstPath);
    const other = createDatabaseProvider(otherDirectoryPath);

    assert.throws(
      () => createDatabaseProvider(sameDirectoryPath),
      DatabaseProviderOwnershipError,
    );

    await first.close();
    const reopened = createDatabaseProvider(sameDirectoryPath);
    await reopened.close();
    await other.close();
  });
});

test('ownership conflicts expose only a stable code and never the canonical directory', async () => {
  await withTempDirectory(async (directory) => {
    const sensitiveDirectory = join(directory, 'token-secret?credential');
    const first = createDatabaseProvider(
      join(sensitiveDirectory, 'first.sqlite'),
    );
    try {
      assert.throws(
        () => createDatabaseProvider(join(sensitiveDirectory, 'second.sqlite')),
        (error) => {
          assert.ok(error instanceof DatabaseProviderOwnershipError);
          assert.equal(error.code, 'ownership_conflict');
          assert.equal(
            error.message,
            'A database provider already owns the data directory',
          );
          assert.equal('dataDirectory' in error, false);
          const serialized = `${String(error)} ${JSON.stringify(error)}`;
          assert.equal(serialized.includes(sensitiveDirectory), false);
          assert.equal(serialized.includes('token-secret'), false);
          assert.equal(serialized.includes('?credential'), false);
          return true;
        },
      );
    } finally {
      await first.close();
    }
  });
});

test('directory preparation failures are path-safe and do not claim ownership', async () => {
  await withTempDirectory(async (directory) => {
    const sensitiveDirectory = join(directory, 'token-secret?credential');
    const blocker = new Database(sensitiveDirectory);
    blocker.close();
    const databasePath = join(sensitiveDirectory, 'database.sqlite');

    assert.throws(
      () => createDatabaseProvider(databasePath),
      (error) => {
        assert.ok(error instanceof DatabaseProviderPathError);
        assert.equal(error.code, 'directory_unavailable');
        assert.equal(error.message, 'Database directory is unavailable');
        assert.equal('cause' in error, false);
        const serialized = `${String(error)} ${JSON.stringify(error)}`;
        assert.equal(serialized.includes(sensitiveDirectory), false);
        assert.equal(serialized.includes('token-secret'), false);
        assert.equal(serialized.includes('?credential'), false);
        return true;
      },
    );

    rmSync(sensitiveDirectory);
    mkdirSync(sensitiveDirectory);
    const provider = createDatabaseProvider(databasePath);
    await provider.close();

    const missingDatabasePath = join(
      directory,
      'missing-token-secret?credential',
      'database.sqlite',
    );
    assert.throws(
      () =>
        createDatabaseProvider(missingDatabasePath, {
          accessMode: 'read-only',
        }),
      (error) => {
        assert.ok(error instanceof DatabaseProviderPathError);
        assert.equal(error.code, 'directory_unavailable');
        assert.equal(error.message, 'Database directory is unavailable');
        assert.equal('cause' in error, false);
        const serialized = `${String(error)} ${JSON.stringify(error)}`;
        assert.equal(serialized.includes(missingDatabasePath), false);
        assert.equal(serialized.includes('token-secret'), false);
        assert.equal(serialized.includes('?credential'), false);
        return true;
      },
    );
  });
});

test('production open failures expose a path-safe typed error', async () => {
  await withTempDirectory(async (directory) => {
    const databasePath = join(
      directory,
      'token-secret?credential',
      'missing.sqlite',
    );
    mkdirSync(join(directory, 'token-secret?credential'));

    assert.throws(
      () => createDatabaseProvider(databasePath, { accessMode: 'read-only' }),
      (error) => {
        assert.ok(error instanceof DatabaseProviderPathError);
        assert.equal(error.code, 'database_open_failed');
        assert.equal(error.message, 'Database could not be opened');
        assert.equal('cause' in error, false);
        const serialized = `${String(error)} ${JSON.stringify(error)}`;
        assert.equal(serialized.includes(databasePath), false);
        assert.equal(serialized.includes('token-secret'), false);
        assert.equal(serialized.includes('?credential'), false);
        return true;
      },
    );
  });
});

test('test connection open failure releases ownership and permits a safe retry', async () => {
  await withTempDirectory(async (directory) => {
    const databasePath = join(
      directory,
      'token-secret?credential',
      'database.sqlite',
    );
    let attempts = 0;
    const options = {
      connectionFactory: (path: string) => {
        attempts += 1;
        if (attempts === 1) {
          throw Object.assign(new Error(`open failed: ${path}`), {
            path,
            cause: new Error(`system failure: ${path}`),
          });
        }
        return new Database(path);
      },
    };

    assert.throws(
      () => createTestDatabaseProvider(databasePath, options),
      (error) => {
        assert.ok(error instanceof DatabaseProviderPathError);
        assert.equal(error.code, 'database_open_failed');
        assert.equal(error.message, 'Database could not be opened');
        assert.equal('cause' in error, false);
        assert.equal('path' in error, false);
        const serialized = `${String(error)} ${JSON.stringify(error)}`;
        assert.equal(serialized.includes(databasePath), false);
        assert.equal(serialized.includes('token-secret'), false);
        assert.equal(serialized.includes('?credential'), false);
        assert.equal(serialized.includes('system failure'), false);
        return true;
      },
    );

    const provider = createTestDatabaseProvider(databasePath, options);
    assert.equal(attempts, 2);
    await provider.close();
  });
});

test('resolves parent directory symlinks before claiming ownership', async () => {
  await withTempDirectory(async (directory) => {
    const realDirectory = join(directory, 'real');
    const aliasDirectory = join(directory, 'alias');
    mkdirSync(realDirectory);
    symlinkSync(realDirectory, aliasDirectory, 'dir');

    const first = createDatabaseProvider(join(realDirectory, 'first.sqlite'));
    try {
      assert.throws(
        () => createDatabaseProvider(join(aliasDirectory, 'second.sqlite')),
        DatabaseProviderOwnershipError,
      );
    } finally {
      await first.close();
    }
  });
});

test('rejects a symbolic link in the final database path before opening it', async () => {
  await withTempDirectory(async (directory) => {
    const targetPath = join(directory, 'target.sqlite');
    const aliasPath = join(directory, 'alias.sqlite');
    const target = new Database(targetPath, { create: true });
    try {
      target.exec('PRAGMA journal_mode = WAL; CREATE TABLE item(value TEXT)');
    } finally {
      target.close(true);
    }
    symlinkSync(targetPath, aliasPath, 'file');

    assert.throws(
      () => createDatabaseProvider(aliasPath),
      (error: unknown) =>
        error instanceof DatabaseProviderPathError &&
        error.code === 'database_open_failed' &&
        !JSON.stringify(error).includes(targetPath),
    );
  });
});

test('initialization failures close an opened connection and release directory ownership', async () => {
  await withTempDirectory(async (directory) => {
    for (const failurePoint of ['configure', 'diagnostics', 'clock'] as const) {
      const databasePath = join(directory, failurePoint, 'database.sqlite');
      const sentinel = new Error(`${failurePoint} failed`);
      let closeCount = 0;
      const hooks = {
        ...(failurePoint === 'configure'
          ? { configureConnection: () => assert.fail(sentinel) }
          : {}),
        ...(failurePoint === 'diagnostics'
          ? { createDiagnostics: () => assert.fail(sentinel) }
          : {}),
        ...(failurePoint === 'clock'
          ? { createClock: () => assert.fail(sentinel) }
          : {}),
        closeConnection: (connection: Database) => {
          closeCount += 1;
          connection.close();
        },
      };

      assert.throws(
        () => createTestDatabaseProvider(databasePath, hooks),
        (error) => error === sentinel,
      );
      assert.equal(closeCount, 1);

      const reopened = createDatabaseProvider(databasePath);
      await reopened.close();
    }
  });
});

test('initialization and cleanup failures preserve the original error first', async () => {
  await withTempDirectory(async (directory) => {
    const initializationError = new Error('diagnostics failed');
    const closeError = new Error('close failed');
    let openedConnection: Database | undefined;

    assert.throws(
      () =>
        createTestDatabaseProvider(join(directory, 'database.sqlite'), {
          connectionFactory: (databasePath) => {
            openedConnection = new Database(databasePath);
            return openedConnection;
          },
          createDiagnostics: () => assert.fail(initializationError),
          closeConnection: (connection) => {
            connection.close();
            throw closeError;
          },
        }),
      (error) => {
        assert.ok(error instanceof AggregateError);
        assert.equal(error.errors[0], initializationError);
        assert.equal(error.errors[1], closeError);
        return true;
      },
    );

    assert.throws(
      () => createDatabaseProvider(join(directory, 'database.sqlite')),
      DatabaseProviderOwnershipError,
    );
    assert.ok(openedConnection);
  });
});

test('opens a business connection distinct from the migration connection', async () => {
  await withTempDirectory(async (directory) => {
    const databasePath = join(directory, 'database.sqlite');
    const migrationConnection = new Database(databasePath);
    let businessConnection: Database | undefined;
    migrationConnection.exec('CREATE TABLE migration_probe (id INTEGER);');
    migrationConnection.close();

    const provider = createTestDatabaseProvider(databasePath, {
      connectionFactory: (path) => {
        businessConnection = new Database(path);
        return businessConnection;
      },
    });

    assert.ok(businessConnection);
    assert.notEqual(businessConnection, migrationConnection);
    assert.equal(
      provider.read(
        (connection) =>
          connection.db
            .select({ count: sql<number>`COUNT(*)` })
            .from(sql.raw('migration_probe'))
            .get()!,
      ).count,
      0,
    );
    await provider.close();
  });
});

test('SQLite clock queries the current connection as a UTC Unix millisecond integer', async () => {
  await withTempDirectory(async (directory) => {
    let clockQueryCalls = 0;
    const provider = createTestDatabaseProvider(
      join(directory, 'database.sqlite'),
      {
        clock: new SqliteDatabaseClock(),
        connectionFactory: (databasePath) => {
          const raw = new Database(databasePath);
          const query = raw.query.bind(raw);
          Object.defineProperty(raw, 'query', {
            configurable: true,
            value: (...arguments_: unknown[]) => {
              if (String(arguments_[0]).includes("strftime('%s', 'now')")) {
                clockQueryCalls += 1;
              }
              return Reflect.apply(query, raw, arguments_);
            },
          });
          return raw;
        },
      },
    );
    try {
      const before = Date.now();
      const now = provider.read((connection) => provider.clock.now(connection));
      const after = Date.now();

      assert.ok(Number.isSafeInteger(now));
      assert.ok(now >= before - 1_000 && now <= after + 1_000);
      assert.equal(clockQueryCalls, 1);
    } finally {
      await provider.close();
    }
  });
});

test('fixed clock returns injected safe integers exactly and rejects invalid values', async () => {
  const exact = 1_700_000_000_123;
  const clock = new FixedDatabaseClock(exact);
  await withTempDirectory(async (directory) => {
    const provider = createTestDatabaseProvider(
      join(directory, 'database.sqlite'),
      { clock },
    );
    assert.equal(
      provider.read((connection) => clock.now(connection)),
      exact,
    );
    await provider.close();
  });

  for (const invalid of [NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => new FixedDatabaseClock(invalid), RangeError);
  }
});

test('does not force clock values to be monotonic across read contexts', async () => {
  await withTempDirectory(async (directory) => {
    const values = [200, 100];
    const sequenceClock: DatabaseClock = {
      now: () => {
        const value = values.shift();
        if (value === undefined) throw new Error('Clock sequence exhausted');
        return value;
      },
    };
    const provider = createTestDatabaseProvider(
      join(directory, 'database.sqlite'),
      { clock: sequenceClock },
    );

    assert.equal(
      provider.read((connection) => provider.clock.now(connection)),
      200,
    );
    assert.equal(
      provider.read((connection) => provider.clock.now(connection)),
      100,
    );
    await provider.close();
  });
});

test('read exposes a revocable facade without a raw Database bypass', async () => {
  await withTempDirectory(async (directory) => {
    const provider = createDatabaseProvider(join(directory, 'database.sqlite'));
    let capturedConnection:
      | Parameters<Parameters<typeof provider.read>[0]>[0]
      | undefined;

    provider.read((connection) => {
      capturedConnection = connection;
      assert.equal('raw' in connection, false);
      assert.equal('$client' in connection.db, false);
      assert.equal((connection.db as { $client?: unknown }).$client, undefined);
    });

    if (capturedConnection === undefined) {
      throw new Error('Read connection was not captured');
    }
    const revokedConnection = capturedConnection;
    assert.throws(() => revokedConnection.db, DatabaseFacadeRevokedError);
    await provider.close();
  });
});

test('read facade rejects write and manual transaction capabilities', async () => {
  await withTempDirectory(async (directory) => {
    const provider = createDatabaseProvider(join(directory, 'database.sqlite'));
    try {
      provider.read((connection) => {
        for (const forbidden of [
          '$client',
          '$count',
          'session',
          'query',
          'insert',
          'update',
          'delete',
          'transaction',
          'run',
          'get',
          'all',
          'values',
        ]) {
          assert.equal(forbidden in connection.db, false, forbidden);
          assert.equal(
            (connection.db as unknown as Record<string, unknown>)[forbidden],
            undefined,
            forbidden,
          );
        }
      });
    } finally {
      await provider.close();
    }
  });
});

test('query builders cannot leak raw state or execute after their read callback', async () => {
  await withTempDirectory(async (directory) => {
    const provider = createDatabaseProvider(join(directory, 'database.sqlite'));
    let capturedBuilder: { all(): unknown[] } | undefined;

    try {
      provider.read((connection) => {
        capturedBuilder = connection.db.select().from(sessions);
        const escaped = capturedBuilder as unknown as Record<string, unknown>;
        assert.equal('session' in escaped, false);
        assert.equal(escaped.session, undefined);
        assert.deepEqual(capturedBuilder.all(), []);
      });

      if (capturedBuilder === undefined) {
        throw new Error('Query builder was not captured');
      }
      const revokedBuilder = capturedBuilder;
      assert.throws(() => revokedBuilder.all(), DatabaseFacadeRevokedError);
      assert.throws(() => {
        (revokedBuilder as unknown as Record<string, unknown>).escaped = true;
      }, DatabaseFacadeRevokedError);
    } finally {
      await provider.close();
    }
  });
});

test('clock rejects a captured connection after the read callback ends', async () => {
  await withTempDirectory(async (directory) => {
    const provider = createDatabaseProvider(join(directory, 'database.sqlite'));
    let capturedConnection:
      | Parameters<Parameters<typeof provider.read>[0]>[0]
      | undefined;

    try {
      provider.read((connection) => {
        capturedConnection = connection;
      });
      if (capturedConnection === undefined) {
        throw new Error('Clock connection was not captured');
      }
      const revokedConnection = capturedConnection;
      assert.throws(
        () => provider.clock.now(revokedConnection),
        DatabaseFacadeRevokedError,
      );
    } finally {
      await provider.close();
    }
  });
});

test('transaction commits writes and revokes its database facade', async () => {
  await withTempDirectory(async (directory) => {
    const provider = createDatabaseProvider(join(directory, 'database.sqlite'));
    let capturedDatabase:
      | Parameters<Parameters<typeof provider.transaction>[0]>[0]['database']
      | undefined;
    try {
      const result = await provider.transaction((transaction) => {
        capturedDatabase = transaction.database;
        transaction.database.db
          .insert(sessions)
          .values({
            id: 'committed',
            snapshot: '{}',
            updatedAt: transaction.now,
          })
          .run();
        return 'committed';
      });

      assert.equal(result, 'committed');
      assert.equal(
        provider.read((connection) =>
          connection.db.select().from(sessions).all(),
        ).length,
        1,
      );
      if (capturedDatabase === undefined) {
        throw new Error('Transaction database was not captured');
      }
      const revokedDatabase = capturedDatabase;
      assert.throws(() => revokedDatabase.db, DatabaseFacadeRevokedError);
    } finally {
      await provider.close();
    }
  });
});

test('a synchronously completed attempt releases transaction ownership before the consumer microtask', async () => {
  await withTempDirectory(async (directory) => {
    const provider = createDatabaseProvider(join(directory, 'database.sqlite'));
    try {
      const first = provider.transaction(() => 'first');
      const second = provider.transaction(() => 'second');
      assert.deepEqual(await Promise.all([first, second]), ['first', 'second']);
    } finally {
      await provider.close();
    }
  });
});

test('callback and constraint failures roll back the complete transaction', async () => {
  await withTempDirectory(async (directory) => {
    const provider = createDatabaseProvider(join(directory, 'database.sqlite'));
    const callbackError = new Error('callback failed');
    try {
      await assert.rejects(
        provider.transaction((transaction) => {
          transaction.database.db
            .insert(sessions)
            .values({
              id: 'callback',
              snapshot: '{}',
              updatedAt: transaction.now,
            })
            .run();
          throw callbackError;
        }),
        (error) => error === callbackError,
      );
      await assert.rejects(
        provider.transaction((transaction) => {
          transaction.database.db
            .insert(sessions)
            .values({
              id: 'constraint',
              snapshot: '{}',
              updatedAt: transaction.now,
            })
            .run();
          transaction.database.db
            .insert(sessions)
            .values({
              id: 'constraint',
              snapshot: '{}',
              updatedAt: transaction.now,
            })
            .run();
        }),
        /UNIQUE constraint failed/,
      );

      assert.deepEqual(
        provider.read((connection) =>
          connection.db.select().from(sessions).all(),
        ),
        [],
      );
    } finally {
      await provider.close();
    }
  });
});

test('commit failures roll back and never report success', async () => {
  await withTempDirectory(async (directory) => {
    const commitError = new Error('commit failed');
    const provider = createTestDatabaseProvider(
      join(directory, 'database.sqlite'),
      {
        executeTransactionControl: (connection, statement) => {
          if (statement === 'COMMIT') throw commitError;
          connection.exec(statement);
        },
      },
    );
    try {
      await assert.rejects(
        provider.transaction((transaction) => {
          transaction.database.db
            .insert(sessions)
            .values({
              id: 'commit',
              snapshot: '{}',
              updatedAt: transaction.now,
            })
            .run();
          return 'must-not-return';
        }),
        (error) => error === commitError,
      );
      assert.deepEqual(
        provider.read((connection) =>
          connection.db.select().from(sessions).all(),
        ),
        [],
      );
    } finally {
      await provider.close();
    }
  });
});

test('rollback failures preserve the original error first', async () => {
  await withTempDirectory(async (directory) => {
    const callbackError = new Error('callback failed');
    const rollbackError = new Error('rollback failed');
    const provider = createTestDatabaseProvider(
      join(directory, 'database.sqlite'),
      {
        executeTransactionControl: (connection, statement) => {
          if (statement === 'ROLLBACK') {
            connection.exec(statement);
            throw rollbackError;
          }
          connection.exec(statement);
        },
      },
    );
    try {
      await assert.rejects(
        provider.transaction(() => {
          throw callbackError;
        }),
        (error) => {
          assert.ok(error instanceof AggregateError);
          assert.deepEqual(error.errors, [callbackError, rollbackError]);
          return true;
        },
      );
    } finally {
      await provider.close();
    }
  });
});

test('a busy transaction with a rollback failure is never retried', async () => {
  await withTempDirectory(async (directory) => {
    const busyError = Object.assign(new Error('busy'), {
      code: 'SQLITE_BUSY',
    });
    const rollbackError = new Error('rollback failed');
    let beginCalls = 0;
    let sleepCalls = 0;
    const provider = createTestDatabaseProvider(
      join(directory, 'database.sqlite'),
      {
        executeTransactionControl: (connection, statement) => {
          if (statement === 'BEGIN IMMEDIATE') beginCalls += 1;
          if (statement === 'ROLLBACK') {
            connection.exec(statement);
            throw rollbackError;
          }
          connection.exec(statement);
        },
        sleep: async () => {
          sleepCalls += 1;
        },
      },
    );
    try {
      await assert.rejects(
        provider.transaction(
          () => {
            throw busyError;
          },
          {
            retry: {
              maxRetries: 1,
              baseDelayMs: 0,
              maxDelayMs: 0,
              jitterRatio: 0,
            },
          },
        ),
        (error) => {
          assert.ok(error instanceof AggregateError);
          assert.deepEqual(error.errors, [busyError, rollbackError]);
          return true;
        },
      );
      assert.equal(beginCalls, 1);
      assert.equal(sleepCalls, 0);
    } finally {
      await provider.close();
    }
  });
});

test('nested transactions and Promise callbacks are rejected and rolled back', async () => {
  await withTempDirectory(async (directory) => {
    const provider = createDatabaseProvider(join(directory, 'database.sqlite'));
    try {
      await assert.rejects(
        provider.transaction((() =>
          provider.transaction(() => undefined)) as never),
        NestedTransactionError,
      );
      await assert.rejects(
        provider.transaction((() => Promise.resolve('async')) as never),
        AsyncTransactionCallbackError,
      );
      assert.deepEqual(
        provider.read((connection) =>
          connection.db.select().from(sessions).all(),
        ),
        [],
      );
    } finally {
      await provider.close();
    }
  });
});

test('a transaction reads the clock once and different transactions read again', async () => {
  await withTempDirectory(async (directory) => {
    const values = [200, 100];
    let calls = 0;
    const provider = createTestDatabaseProvider(
      join(directory, 'database.sqlite'),
      {
        clock: {
          now: () => {
            calls += 1;
            const value = values.shift();
            if (value === undefined) {
              throw new Error('Clock sequence exhausted');
            }
            return value;
          },
        },
      },
    );
    try {
      const first = await provider.transaction((transaction) => [
        transaction.now,
        transaction.now,
      ]);
      const second = await provider.transaction(
        (transaction) => transaction.now,
      );
      assert.deepEqual(first, [200, 200]);
      assert.equal(second, 100);
      assert.equal(calls, 2);
    } finally {
      await provider.close();
    }
  });
});

test('COMMIT busy rolls back without replaying an already executed callback', async () => {
  await withTempDirectory(async (directory) => {
    let callbackCalls = 0;
    let preparationCalls = 0;
    const delays: number[] = [];
    const prepared = (() => {
      preparationCalls += 1;
      return { id: 'retried' };
    })();
    const provider = createTestDatabaseProvider(
      join(directory, 'database.sqlite'),
      {
        executeTransactionControl: (connection, statement) => {
          if (statement === 'COMMIT') {
            throw Object.assign(new Error('database busy'), {
              code: 'SQLITE_BUSY',
            });
          }
          connection.exec(statement);
        },
        sleep: async (delayMs) => {
          delays.push(delayMs);
        },
        random: () => 0.5,
      },
    );
    try {
      await assert.rejects(
        provider.transaction(
          (transaction) => {
            callbackCalls += 1;
            transaction.database.db
              .insert(sessions)
              .values({
                id: prepared.id,
                snapshot: '{}',
                updatedAt: transaction.now,
              })
              .run();
          },
          {
            retry: {
              maxRetries: 2,
              baseDelayMs: 10,
              maxDelayMs: 100,
              jitterRatio: 0,
            },
          },
        ),
        (error: unknown) =>
          typeof error === 'object' &&
          error !== null &&
          (error as { code?: unknown }).code === 'SQLITE_BUSY',
      );

      assert.equal(preparationCalls, 1);
      assert.equal(callbackCalls, 1);
      assert.deepEqual(delays, []);
      assert.equal(
        provider.read((connection) =>
          connection.db.select().from(sessions).all(),
        ).length,
        0,
      );
    } finally {
      await provider.close();
    }
  });
});

test('real BEGIN busy never calls the callback and retries once after the competing connection releases', async () => {
  await withTempDirectory(async (directory) => {
    const databasePath = join(directory, 'database.sqlite');
    const sleepEntered = createGate();
    const releaseRetry = createGate();
    let callbackCalls = 0;
    const provider = createTestDatabaseProvider(databasePath, {
      sleep: async () => {
        sleepEntered.resolve();
        await releaseRetry.promise;
      },
    });
    const lockHolder = new Database(databasePath);
    configureSqliteConnection(lockHolder, 'business-read-write');
    lockHolder.exec('BEGIN IMMEDIATE');
    try {
      const transactionPromise = provider.transaction(
        (transaction) => {
          callbackCalls += 1;
          transaction.database.db
            .insert(sessions)
            .values({
              id: 'after-real-busy',
              snapshot: '{}',
              updatedAt: transaction.now,
            })
            .run();
        },
        {
          retry: {
            maxRetries: 1,
            baseDelayMs: 0,
            maxDelayMs: 0,
            jitterRatio: 0,
          },
        },
      );
      await sleepEntered.promise;
      assert.equal(callbackCalls, 0);
      lockHolder.exec('ROLLBACK');
      releaseRetry.resolve();
      await transactionPromise;
      assert.equal(callbackCalls, 1);
      assert.equal(
        provider.read((connection) =>
          connection.db.select().from(sessions).all(),
        ).length,
        1,
      );
    } finally {
      try {
        lockHolder.exec('ROLLBACK');
      } catch {
        // The successful path already released the competing transaction.
      }
      lockHolder.close();
      releaseRetry.resolve();
      await provider.close();
    }
  });
});

test('busy retry exhaustion reports attempts and the final SQLite error', async () => {
  await withTempDirectory(async (directory) => {
    const busy = Object.assign(new Error('locked'), { code: 'SQLITE_LOCKED' });
    const provider = createTestDatabaseProvider(
      join(directory, 'database.sqlite'),
      {
        executeTransactionControl: (_connection, statement) => {
          if (statement === 'BEGIN IMMEDIATE') throw busy;
        },
        sleep: async () => undefined,
      },
    );
    try {
      await assert.rejects(
        provider.transaction(() => undefined, {
          retry: {
            maxRetries: 2,
            baseDelayMs: 0,
            maxDelayMs: 0,
            jitterRatio: 0,
          },
        }),
        (error) => {
          assert.ok(error instanceof DatabaseBusyRetryExhaustedError);
          assert.equal(error.attempts, 3);
          assert.equal(error.cause, busy);
          return true;
        },
      );
    } finally {
      await provider.close();
    }
  });
});

test('retry budget accepts exactly 2000ms and rejects one millisecond more before BEGIN', async () => {
  await withTempDirectory(async (directory) => {
    let beginCalls = 0;
    let callbackCalls = 0;
    const delays: number[] = [];
    const provider = createTestDatabaseProvider(
      join(directory, 'database.sqlite'),
      {
        executeTransactionControl: (connection, statement) => {
          if (statement === 'BEGIN IMMEDIATE') {
            beginCalls += 1;
            if (beginCalls === 1) {
              throw Object.assign(new Error('busy'), { code: 'SQLITE_BUSY' });
            }
          }
          connection.exec(statement);
        },
        sleep: async (delay) => {
          delays.push(delay);
        },
      },
    );
    try {
      await provider.transaction(
        () => {
          callbackCalls += 1;
        },
        {
          retry: {
            maxRetries: 1,
            baseDelayMs: 1_500,
            maxDelayMs: 1_500,
            jitterRatio: 0,
          },
        },
      );
      assert.deepEqual(delays, [1_500]);
      assert.equal(beginCalls, 2);
      assert.equal(callbackCalls, 1);

      const callsBeforeRejection = beginCalls;
      assert.throws(
        () =>
          provider.transaction(
            () => {
              callbackCalls += 1;
            },
            {
              retry: {
                maxRetries: 1,
                baseDelayMs: 1_501,
                maxDelayMs: 1_501,
                jitterRatio: 0,
              },
            },
          ),
        RangeError,
      );
      assert.equal(beginCalls, callsBeforeRejection);
      assert.equal(callbackCalls, 1);
    } finally {
      await provider.close();
    }
  });
});

test('retry budget rejects excessive or overflowing inputs in constant bounded work', async () => {
  await withTempDirectory(async (directory) => {
    let beginCalls = 0;
    const provider = createTestDatabaseProvider(
      join(directory, 'database.sqlite'),
      {
        executeTransactionControl: () => {
          beginCalls += 1;
        },
      },
    );
    try {
      for (const retry of [
        {
          maxRetries: 8,
          baseDelayMs: 0,
          maxDelayMs: 0,
          jitterRatio: 0,
        },
        {
          maxRetries: Number.MAX_SAFE_INTEGER,
          baseDelayMs: Number.MAX_SAFE_INTEGER,
          maxDelayMs: Number.MAX_SAFE_INTEGER,
          jitterRatio: 1,
        },
        {
          maxRetries: 7,
          baseDelayMs: 1,
          maxDelayMs: Number.MAX_SAFE_INTEGER,
          jitterRatio: 1,
        },
      ]) {
        assert.throws(
          () => provider.transaction(() => undefined, { retry }),
          RangeError,
        );
      }
      assert.equal(beginCalls, 0);
    } finally {
      await provider.close();
    }
  });
});

test('busy retry cannot start another attempt after Provider close', async () => {
  await withTempDirectory(async (directory) => {
    let beginCalls = 0;
    let closePromise: Promise<void> | undefined;
    const provider = createTestDatabaseProvider(
      join(directory, 'database.sqlite'),
      {
        executeTransactionControl: (connection, statement) => {
          if (statement === 'BEGIN IMMEDIATE') {
            beginCalls += 1;
            throw Object.assign(new Error('busy'), { code: 'SQLITE_BUSY' });
          }
          connection.exec(statement);
        },
        sleep: async () => {
          closePromise = provider.close();
        },
      },
    );

    await assert.rejects(
      provider.transaction(() => undefined, {
        retry: {
          maxRetries: 1,
          baseDelayMs: 0,
          maxDelayMs: 0,
          jitterRatio: 0,
        },
      }),
      DatabaseProviderClosedError,
    );
    assert.equal(beginCalls, 1);
    assert.ok(closePromise);
    await closePromise;
  });
});
