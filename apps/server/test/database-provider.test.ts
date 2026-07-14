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
  NestedTransactionError,
  createDatabaseProvider,
} from '../src/persistence/database-provider';
import { createTestDatabaseProvider } from '../src/persistence/database-provider.testing';
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

      assert.deepEqual(rows, []);
      assert.equal(journalMode?.journal_mode.toLowerCase(), 'wal');
      assert.equal(foreignKeys?.foreign_keys, 1);
      assert.equal(busyTimeout?.timeout, 5_000);
      assert.equal(synchronous?.synchronous, 2);
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
      provider.read((connection) =>
        connection.db
          .select({ count: sql<number>`COUNT(*)` })
          .from(sql.raw('migration_probe'))
          .get(),
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
    let capturedBuilder: ReturnType<
      ReturnType<
        Parameters<Parameters<typeof provider.read>[0]>[0]['db']['select']
      >['from']
    >;

    try {
      provider.read((connection) => {
        capturedBuilder = connection.db.select().from(sessions);
        const escaped = capturedBuilder as unknown as Record<string, unknown>;
        assert.equal('session' in escaped, false);
        assert.equal(escaped.session, undefined);
        assert.deepEqual(capturedBuilder.all(), []);
      });

      assert.throws(() => capturedBuilder.all(), DatabaseFacadeRevokedError);
      assert.throws(() => {
        (capturedBuilder as unknown as Record<string, unknown>).escaped = true;
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
      assert.ok(capturedConnection);
      assert.throws(
        () => provider.clock.now(capturedConnection),
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
      assert.ok(capturedDatabase);
      assert.throws(() => capturedDatabase.db, DatabaseFacadeRevokedError);
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

test('nested transactions and Promise callbacks are rejected and rolled back', async () => {
  await withTempDirectory(async (directory) => {
    const provider = createDatabaseProvider(join(directory, 'database.sqlite'));
    try {
      await assert.rejects(
        provider.transaction(() => provider.transaction(() => undefined)),
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
            assert.notEqual(value, undefined);
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

test('busy retry restarts the complete transaction with deterministic backoff', async () => {
  await withTempDirectory(async (directory) => {
    let commitCalls = 0;
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
          if (statement === 'COMMIT' && commitCalls++ < 2) {
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
      await provider.transaction(
        (transaction) => {
          callbackCalls += 1;
          transaction.database.db
            .insert(sessions)
            .values({
              id: prepared.id,
              snapshot: '{}',
              updatedAt: transaction.now,
            })
            .onConflictDoNothing()
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
      );

      assert.equal(preparationCalls, 1);
      assert.equal(callbackCalls, 3);
      assert.deepEqual(delays, [10, 20]);
      assert.equal(
        provider.read((connection) =>
          connection.db.select().from(sessions).all(),
        ).length,
        1,
      );
    } finally {
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

test('busy retry cannot start another attempt after Provider close', async () => {
  await withTempDirectory(async (directory) => {
    let beginCalls = 0;
    const provider = createTestDatabaseProvider(
      join(directory, 'database.sqlite'),
      {
        executeTransactionControl: (connection, statement) => {
          if (statement === 'BEGIN IMMEDIATE') beginCalls += 1;
          if (statement === 'COMMIT') {
            throw Object.assign(new Error('busy'), { code: 'SQLITE_BUSY' });
          }
          connection.exec(statement);
        },
        sleep: async () => {
          await provider.close();
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
  });
});
