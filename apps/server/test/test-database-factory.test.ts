import { strict as assert } from 'node:assert';
import { readdirSync } from 'node:fs';
import { access, readdir } from 'node:fs/promises';
import { test } from 'node:test';
import { Database } from 'bun:sqlite';
import { DatabaseReadOnlyError } from '../src/persistence/database-provider';
import { MigrationError } from '../src/persistence/migration-framework';
import { MigrationRecoveryError } from '../src/persistence/migration-bootstrap';
import { sessions } from '../src/persistence/schema';
import {
  TestDatabaseClock,
  createTestDatabase,
  useTestDatabase,
  withRawTestConnection,
} from './support/test-database-factory';

test('factory databases are isolated and inject a fixed database clock', async () => {
  const [first, second] = await Promise.all([
    createTestDatabase({ now: 111 }),
    createTestDatabase({ now: 222 }),
  ]);
  try {
    assert.notEqual(first.dataDirectory, second.dataDirectory);
    assert.notEqual(first.databasePath, second.databasePath);
    await first.provider.transaction(({ database, now }) => {
      database.db
        .insert(sessions)
        .values({ id: 'only-first', snapshot: '{}', updatedAt: now })
        .run();
    });
    assert.equal(
      first.provider.read((connection) => first.clock.now(connection)),
      111,
    );
    assert.equal(
      second.provider.read((connection) => second.clock.now(connection)),
      222,
    );
    assert.equal(
      second.provider.read((connection) =>
        connection.db.select().from(sessions).all(),
      ).length,
      0,
    );
  } finally {
    await Promise.all([first.close(), second.close()]);
  }
});

test('factory provides scoped raw access and controlled lock contention', async () => {
  const database = await createTestDatabase();
  try {
    await assert.rejects(
      database.acquireConflictingInstanceLock(),
      /already in use|locked|conflict/i,
    );
    assert.equal(
      withRawTestConnection(database, 'lock-holder', (raw) =>
        raw.query<{ user_version: number }, []>('PRAGMA user_version').get(),
      )?.user_version,
      0,
    );
    assert.throws(
      () =>
        withRawTestConnection(database, 'lock-holder', async () => {
          await Promise.resolve();
        }),
      /must be synchronous/,
    );
    const release = database.holdBusyLock();
    await assert.rejects(
      database.provider.transaction(() => undefined),
      (error: unknown) =>
        typeof error === 'object' &&
        error !== null &&
        (error as { code?: unknown }).code === 'SQLITE_BUSY',
    );
    release();
  } finally {
    await database.close();
  }
});

test('factory closes in parallel, releases locks, and removes directories', async () => {
  const databases = await Promise.all(
    Array.from({ length: 4 }, () => createTestDatabase({ kind: 'legacy-1x' })),
  );
  const directories = databases.map(({ dataDirectory }) => dataDirectory);
  await Promise.all(databases.map((database) => database.close()));
  await Promise.all(
    directories.map(async (directory) => {
      await assert.rejects(access(directory));
    }),
  );
});

test('factory close is idempotent and returns one cleanup promise', async () => {
  const database = await createTestDatabase();
  const first = database.close();
  const second = database.close();
  assert.equal(second, first);
  await first;
  await assert.rejects(access(database.dataDirectory));
});

test('factory restart closes Provider, releases and reacquires Instance Lock, and preserves data', async () => {
  const database = await createTestDatabase({ kind: 'migrated', now: 321 });
  const firstProvider = database.provider;
  try {
    await firstProvider.transaction(({ database: connection, now }) => {
      connection.db
        .insert(sessions)
        .values({ id: 'restart-row', snapshot: '{}', updatedAt: now })
        .run();
    });

    await database.restart();
    assert.notEqual(database.provider, firstProvider);
    assert.equal(
      database.provider.read((connection) =>
        connection.db.select().from(sessions).all(),
      )[0]?.id,
      'restart-row',
    );
    await assert.rejects(
      database.acquireConflictingInstanceLock(),
      /already in use|locked|conflict/i,
    );
  } finally {
    await database.close();
  }
  await assert.rejects(access(database.dataDirectory));
});

test('factory rejects new raw and busy resources once close starts', async () => {
  const database = await createTestDatabase();
  const release = database.holdBusyLock();
  const closing = database.close();

  assert.throws(
    () => database.holdBusyLock(),
    /Test database is closing or closed/,
  );
  assert.throws(
    () =>
      withRawTestConnection(database, 'read-only', () => {
        throw new Error('operation must not run');
      }),
    /Test database is closing or closed/,
  );

  await closing;
  assert.doesNotThrow(release);
});

test('factory close waits for a raw callback that initiated shutdown', async () => {
  const database = await createTestDatabase();
  let closing: Promise<void> | undefined;

  withRawTestConnection(database, 'read-only', (raw) => {
    assert.equal(
      raw.query<{ value: number }, []>('SELECT 1 AS value').get()?.value,
      1,
    );
    closing = database.close();
    assert.equal(
      raw.query<{ value: number }, []>('SELECT 2 AS value').get()?.value,
      2,
    );
  });

  assert.ok(closing);
  await closing;
  await assert.rejects(access(database.dataDirectory));
});

test('factory migration failure restores its backup before cleanup', async () => {
  const injected = new Error('injected migration failure');
  let dataDirectory: string | undefined;
  let recoveryObserved = false;
  await assert.rejects(
    createTestDatabase({
      migrationFailure: injected,
      observeDataDirectory(directory) {
        dataDirectory = directory;
      },
      observeMigrationRecovery(databasePath, error) {
        recoveryObserved = true;
        assert.ok(error instanceof MigrationRecoveryError);
        assert.equal(error.code, 'migration_failed_recovered');
        const restored = new Database(databasePath, { readonly: true });
        try {
          assert.deepEqual(
            restored
              .query<
                { version: number },
                []
              >('SELECT version FROM schema_migrations ORDER BY version')
              .all(),
            [{ version: 1 }],
          );
        } finally {
          restored.close(true);
        }
        assert.equal(readdirSync(`${dataDirectory}/backups`).length, 1);
        assert.equal(
          readdirSync(`${dataDirectory}/migration-quarantine`).length,
          1,
        );
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      return true;
    },
  );
  assert.equal(recoveryObserved, true);
  assert.ok(dataDirectory);
  await assert.rejects(access(dataDirectory));
});

test('test database clock supports deterministic set and advance with safe integers', async () => {
  const clock = new TestDatabaseClock(100);
  const database = await createTestDatabase({ clock });
  try {
    assert.equal(
      database.provider.read((connection) => clock.now(connection)),
      100,
    );
    clock.set(250);
    clock.advance(25);
    assert.equal(
      database.provider.read((connection) => clock.now(connection)),
      275,
    );
    assert.throws(() => clock.advance(Number.MAX_SAFE_INTEGER), RangeError);
    assert.equal(
      database.provider.read((connection) => clock.now(connection)),
      275,
    );
  } finally {
    await database.close();
  }
});

test('factory creates readonly and explicit schema-version databases', async () => {
  const readonly = await createTestDatabase({ accessMode: 'read-only' });
  const versionZero = await createTestDatabase({ schemaVersion: 0 });
  try {
    assert.equal(readonly.provider.accessMode, 'read-only');
    assert.throws(
      () => readonly.provider.transaction(() => undefined),
      DatabaseReadOnlyError,
    );
    assert.equal(
      withRawTestConnection(versionZero, 'lock-holder', (raw) =>
        raw
          .query<
            { count: number },
            []
          >("SELECT count(*) AS count FROM sqlite_schema WHERE name = 'schema_migrations'")
          .get(),
      )?.count,
      0,
    );
  } finally {
    await Promise.all([readonly.close(), versionZero.close()]);
  }
});

test('factory rejects unknown schema versions and kinds without leaving directories', async () => {
  for (const options of [
    { schemaVersion: 2 as never },
    { kind: 'future-schema' as never },
  ]) {
    let directory: string | undefined;
    await assert.rejects(
      createTestDatabase({
        ...options,
        observeDataDirectory(value) {
          directory = value;
        },
      }),
      /Unknown test database/,
    );
    assert.ok(directory);
    await assert.rejects(access(directory));
  }
});

test('empty scenario performs the full bootstrap while schema version zero stays unmanaged', async () => {
  const emptyStages: string[] = [];
  const migratedStages: string[] = [];
  const emptyStartup = await createTestDatabase({
    kind: 'empty',
    observeMigrationBootstrap(stage) {
      emptyStages.push(stage);
    },
  });
  const migratedStartup = await createTestDatabase({
    kind: 'migrated',
    observeMigrationBootstrap(stage) {
      migratedStages.push(stage);
    },
  });
  const unmanaged = await createTestDatabase({ schemaVersion: 0 });
  try {
    assert.deepEqual(emptyStages, ['startup']);
    assert.deepEqual(migratedStages, ['preparation', 'startup']);
    assert.equal(
      withRawTestConnection(emptyStartup, 'read-only', (raw) =>
        raw
          .query<
            { count: number },
            []
          >('SELECT count(*) AS count FROM schema_migrations')
          .get(),
      )?.count,
      1,
    );
    assert.equal(
      withRawTestConnection(unmanaged, 'lock-holder', (raw) =>
        raw
          .query<
            { count: number },
            []
          >("SELECT count(*) AS count FROM sqlite_schema WHERE name = 'schema_migrations'")
          .get(),
      )?.count,
      0,
    );
  } finally {
    await Promise.all([
      emptyStartup.close(),
      migratedStartup.close(),
      unmanaged.close(),
    ]);
  }
});

test('factory exposes deterministic 1.x historical variants through one API', async () => {
  for (const variant of [
    'normal',
    'missing-optional',
    'orphaned',
    'corrupt-record',
  ] as const) {
    const database = await createTestDatabase({
      kind: 'legacy-1x',
      legacyVariant: variant,
    });
    try {
      const state = withRawTestConnection(database, 'read-only', (raw) => ({
        sessions: raw
          .query<
            { count: number },
            []
          >('SELECT count(*) AS count FROM sessions')
          .get()?.count,
        orphaned: raw
          .query<
            { count: number },
            []
          >("SELECT count(*) AS count FROM audit WHERE session_id = 'missing-session'")
          .get()?.count,
      }));
      assert.equal(
        state.sessions,
        variant === 'missing-optional' || variant === 'corrupt-record' ? 2 : 1,
      );
      assert.equal(state.orphaned, variant === 'orphaned' ? 1 : 0);
    } finally {
      await database.close();
    }
  }
});

test('factory preserves a real uncheckpointed WAL fixture until cleanup', async () => {
  const database = await createTestDatabase({ kind: 'wal-uncheckpointed' });
  try {
    const state = withRawTestConnection(database, 'lock-holder', (raw) => ({
      rowCount: raw
        .query<
          { count: number },
          []
        >("SELECT count(*) AS count FROM audit WHERE tool_use_id = 'wal-fixture-use'")
        .get()?.count,
      walFrames: raw
        .query<{ log: number }, []>('PRAGMA wal_checkpoint(PASSIVE)')
        .get()?.log,
    }));
    assert.equal(state.rowCount, 1);
    assert.ok((state.walFrames ?? 0) > 0);
    const backupDirectories = await readdir(
      `${database.dataDirectory}/backups`,
    );
    assert.equal(backupDirectories.length, 1);
    const snapshot = new Database(
      `${database.dataDirectory}/backups/${backupDirectories[0]}/colorful-code.db`,
      { readonly: true },
    );
    try {
      assert.equal(
        snapshot
          .query<
            { count: number },
            []
          >("SELECT count(*) AS count FROM audit WHERE tool_use_id = 'wal-fixture-use'")
          .get()?.count,
        1,
      );
      assert.equal(
        snapshot
          .query<
            { count: number },
            []
          >("SELECT count(*) AS count FROM sqlite_schema WHERE name = 'schema_migrations'")
          .get()?.count,
        0,
      );
    } finally {
      snapshot.close(true);
    }
  } finally {
    await database.close();
  }
});

test('factory corrupt migration fixture is rejected before Provider and cleaned', async () => {
  let directory: string | undefined;
  await assert.rejects(
    createTestDatabase({
      kind: 'corrupt-migration',
      observeDataDirectory(value) {
        directory = value;
      },
    }),
    (error: unknown) =>
      error instanceof MigrationError && error.code === 'checksum_mismatch',
  );
  assert.ok(directory);
  await assert.rejects(access(directory));
});

test('raw test access requires an explicit role and closes after callback', async () => {
  const database = await createTestDatabase();
  let captured: Database | undefined;
  try {
    withRawTestConnection(database, 'read-only', (raw) => {
      captured = raw;
      assert.equal(
        raw.query<{ query_only: number }, []>('PRAGMA query_only').get()
          ?.query_only,
        1,
      );
    });
    assert.ok(captured);
    assert.throws(() => captured!.query('SELECT 1').get());
  } finally {
    await database.close();
  }
});

test('useTestDatabase keeps the body error first after real cleanup faults', async () => {
  const bodyError = new Error('body failed');
  const cleanupError = new Error('synthetic cleanup failed');
  let directory: string | undefined;
  await assert.rejects(
    useTestDatabase(
      {
        cleanupFaults: { afterDirectoryRemove: cleanupError },
        observeDataDirectory(value) {
          directory = value;
        },
      },
      () => {
        throw bodyError;
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [bodyError, cleanupError]);
      return true;
    },
  );
  assert.ok(directory);
  await assert.rejects(access(directory));
});
