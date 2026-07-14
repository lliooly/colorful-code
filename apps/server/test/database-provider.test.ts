import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
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
  DatabaseFacadeRevokedError,
  DatabaseProviderClosedError,
  DatabaseProviderOwnershipError,
  createDatabaseProvider,
  createTestDatabaseProvider,
} from '../src/persistence/database-provider';
import { sessions } from '../src/persistence/schema';

async function withTempDirectory<T>(
  body: (directory: string) => T | Promise<T>,
): Promise<T> {
  const directory = mkdtempSync(join(tmpdir(), 'colorful-code-provider-'));
  try {
    return await body(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('initializes the legacy schema and production SQLite pragmas before reads', async () => {
  await withTempDirectory(async (directory) => {
    const provider = createDatabaseProvider(join(directory, 'database.sqlite'));
    try {
      const result = provider.read((connection) => ({
        rows: connection.db.select().from(sessions).all(),
        journalMode: connection.db.get(sql`PRAGMA journal_mode`) as [string],
        foreignKeys: connection.db.get(sql`PRAGMA foreign_keys`) as [number],
        busyTimeout: connection.db.get(sql`PRAGMA busy_timeout`) as [number],
        synchronous: connection.db.get(sql`PRAGMA synchronous`) as [number],
      }));

      assert.deepEqual(result.rows, []);
      assert.equal(result.journalMode[0].toLowerCase(), 'wal');
      assert.equal(result.foreignKeys[0], 1);
      assert.equal(result.busyTimeout[0], 5_000);
      assert.equal(result.synchronous[0], 2);
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

test('initialization failures close an opened connection and release directory ownership', async () => {
  await withTempDirectory(async (directory) => {
    for (const failurePoint of ['configure', 'schema', 'clock'] as const) {
      const databasePath = join(directory, failurePoint, 'database.sqlite');
      const sentinel = new Error(`${failurePoint} failed`);
      let closeCount = 0;
      const hooks = {
        ...(failurePoint === 'configure'
          ? { configureConnection: () => assert.fail(sentinel) }
          : {}),
        ...(failurePoint === 'schema'
          ? { initializeSchema: () => assert.fail(sentinel) }
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
    const initializationError = new Error('schema failed');
    const closeError = new Error('close failed');
    let openedConnection: Database | undefined;

    assert.throws(
      () =>
        createTestDatabaseProvider(join(directory, 'database.sqlite'), {
          connectionFactory: (databasePath) => {
            openedConnection = new Database(databasePath);
            return openedConnection;
          },
          initializeSchema: () => assert.fail(initializationError),
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

    const reopened = createDatabaseProvider(join(directory, 'database.sqlite'));
    await reopened.close();
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
      provider.read((connection) =>
        connection.db.get(sql`SELECT COUNT(*) AS count FROM migration_probe`),
      )[0],
      0,
    );
    await provider.close();
  });
});

test('SQLite clock queries the current connection as a UTC Unix millisecond integer', async () => {
  await withTempDirectory(async (directory) => {
    const provider = createTestDatabaseProvider(
      join(directory, 'database.sqlite'),
      { clock: new SqliteDatabaseClock() },
    );
    try {
      const before = Date.now();
      const now = provider.read((connection) => provider.clock.now(connection));
      const after = Date.now();

      assert.ok(Number.isSafeInteger(now));
      assert.ok(now >= before - 1_000 && now <= after + 1_000);
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
        assert.notEqual(value, undefined);
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

    assert.ok(capturedConnection);
    assert.throws(() => capturedConnection.db, DatabaseFacadeRevokedError);
    await provider.close();
  });
});
