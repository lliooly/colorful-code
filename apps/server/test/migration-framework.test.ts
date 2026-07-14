import { strict as assert } from 'node:assert';
import {
  access,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Database } from 'bun:sqlite';
import {
  bootstrapMigrations,
  MIGRATIONS,
  MigrationRecoveryError,
} from '../src/persistence/migration-bootstrap';
import { createMigrationBackup } from '../src/persistence/migration-backup-recovery';
import {
  MigrationError,
  migrationChecksum,
  runMigrations,
  validateMigrationRegistry,
  type Migration,
} from '../src/persistence/migration-framework';

async function withDatabase(
  run: (database: Database) => void | Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'colorful-code-migrations-'));
  const database = new Database(join(directory, 'test.db'), { create: true });
  try {
    await run(database);
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
}

function migration(version: number, name: string, source: string): Migration {
  return { version, name, source, up() {} };
}

function noPendingMigration(version = 0) {
  return {
    inspectSchema: () => ({ initialized: true, version }),
    verifyMigratedDatabase: () => undefined,
  };
}

test('production migration registry freezes the published 1.x baseline', () => {
  assert.equal(Object.isFrozen(MIGRATIONS), true);
  assert.equal(MIGRATIONS.length, 1);
  assert.equal(MIGRATIONS[0]?.version, 1);
  assert.equal(MIGRATIONS[0]?.name, 'legacy_1x_baseline');
  assert.equal(Object.isFrozen(MIGRATIONS[0]), true);
});

test('bootstrap creates migration metadata in an empty file database and closes it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'colorful-code-bootstrap-'));
  const databasePath = join(directory, 'nested', 'bootstrap.db');

  try {
    await bootstrapMigrations(databasePath);

    const reopened = new Database(databasePath, { readonly: true });
    try {
      assert.equal(
        reopened
          .query<
            { count: number },
            []
          >("SELECT count(*) AS count FROM sqlite_schema WHERE type = 'table' AND name = 'schema_migrations'")
          .get()!.count,
        1,
      );
      assert.deepEqual(
        reopened
          .query<
            { version: number; name: string },
            []
          >('SELECT version, name FROM schema_migrations')
          .all(),
        [{ version: 1, name: 'legacy_1x_baseline' }],
      );
      assert.equal(
        reopened
          .query<
            { count: number },
            []
          >("SELECT count(*) AS count FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
          .get()!.count,
        7,
      );
    } finally {
      reopened.close(true);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('managed database drift during backup is rejected before migration without restoring over the new write', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'managed-backup-drift-'));
  const databasePath = join(directory, 'database.sqlite');
  const first: Migration = {
    version: 1,
    name: 'create_notes',
    source: 'CREATE TABLE notes(body TEXT NOT NULL);',
    up(database) {
      database.exec('CREATE TABLE notes(body TEXT NOT NULL)');
    },
  };
  const second: Migration = {
    version: 2,
    name: 'add_note_kind',
    source: 'ALTER TABLE notes ADD COLUMN kind TEXT;',
    up(database) {
      database.exec('ALTER TABLE notes ADD COLUMN kind TEXT');
    },
  };

  try {
    const initial = new Database(databasePath, { create: true });
    try {
      runMigrations(initial, [first]);
    } finally {
      initial.close(true);
    }

    await assert.rejects(
      bootstrapMigrations(databasePath, {
        migrations: [first, second],
        createBackup(options) {
          const backup = createMigrationBackup({
            ...options,
            database: options.database as Database,
          });
          const concurrent = new Database(databasePath, { readwrite: true });
          try {
            concurrent.query('INSERT INTO notes(body) VALUES (?)').run('new');
          } finally {
            concurrent.close(true);
          }
          return backup;
        },
      }),
      (error: unknown) =>
        error instanceof MigrationError &&
        error.code === 'database_changed_during_backup',
    );

    const reopened = new Database(databasePath, { readonly: true });
    try {
      assert.deepEqual(reopened.query('SELECT body FROM notes').all(), [
        { body: 'new' },
      ]);
      assert.deepEqual(
        reopened
          .query<{ name: string }, [string]>(
            'SELECT name FROM pragma_table_info(?)',
          )
          .all('notes')
          .map(({ name }) => name),
        ['body'],
      );
    } finally {
      reopened.close(true);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('bootstrap reopens a file database without reapplying a recorded migration', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'colorful-code-restart-'));
  const databasePath = join(directory, 'restart.db');
  let upCalls = 0;
  const entry: Migration = {
    version: 1,
    name: 'create_bootstrap_probe',
    source: 'CREATE TABLE bootstrap_probe(id INTEGER);',
    up(database) {
      upCalls += 1;
      database.exec(this.source);
    },
  };

  try {
    await bootstrapMigrations(databasePath, { migrations: [entry] });
    await bootstrapMigrations(databasePath, { migrations: [entry] });

    assert.equal(upCalls, 1);
    assert.equal((await readdir(join(directory, 'backups'))).length, 1);
    const reopened = new Database(databasePath, { readonly: true });
    try {
      assert.deepEqual(
        reopened
          .query<
            { version: number; name: string; checksum: string },
            []
          >('SELECT version, name, checksum FROM schema_migrations')
          .all(),
        [
          {
            version: 1,
            name: entry.name,
            checksum: migrationChecksum(entry),
          },
        ],
      );
      assert.equal(
        reopened
          .query<
            { count: number },
            []
          >("SELECT count(*) AS count FROM sqlite_schema WHERE type = 'table' AND name = 'bootstrap_probe'")
          .get()!.count,
        1,
      );
    } finally {
      reopened.close(true);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('bootstrap closes, quarantines, and restores the pre-migration backup after a later migration fails', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'migration-recovery-'));
  const databasePath = join(directory, 'app.db');
  const base: Migration = {
    version: 1,
    name: 'base',
    source: 'create notes table and seed old content',
    up(database) {
      database.exec('CREATE TABLE notes(body TEXT NOT NULL)');
      database.exec("INSERT INTO notes VALUES ('old content')");
    },
  };
  const committedBeforeFailure: Migration = {
    version: 2,
    name: 'committed_before_failure',
    source: 'insert committed content',
    up(database) {
      database.exec("INSERT INTO notes VALUES ('migration 2 content')");
    },
  };
  const failing: Migration = {
    version: 3,
    name: 'failing',
    source: 'create then fail',
    up(database) {
      database.exec('CREATE TABLE should_rollback(id INTEGER)');
      throw new Error('injected migration failure');
    },
  };

  try {
    const initial = new Database(databasePath, { create: true });
    runMigrations(initial, [base]);
    initial.close(true);

    await assert.rejects(
      bootstrapMigrations(databasePath, {
        migrations: [base, committedBeforeFailure, failing],
      }),
      (error: unknown) =>
        error instanceof MigrationRecoveryError &&
        error.code === 'migration_failed_recovered',
    );

    const restored = new Database(databasePath, { readonly: true });
    try {
      assert.deepEqual(
        restored.query<{ body: string }, []>('SELECT body FROM notes').all(),
        [{ body: 'old content' }],
      );
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

    const backupEntries = await readdir(join(directory, 'backups'));
    assert.equal(backupEntries.length, 1);
    const manifest = JSON.parse(
      await readFile(
        join(directory, 'backups', backupEntries[0]!, 'manifest.json'),
        'utf8',
      ),
    );
    assert.equal(manifest.sourceSchemaVersion, 1);
    assert.equal(manifest.targetSchemaVersion, 3);

    const quarantineEntries = await readdir(
      join(directory, 'migration-quarantine'),
    );
    assert.equal(quarantineEntries.length, 1);
    const failed = new Database(
      join(directory, 'migration-quarantine', quarantineEntries[0]!, 'app.db'),
      { readonly: true },
    );
    try {
      assert.deepEqual(
        failed.query<{ body: string }, []>('SELECT body FROM notes').all(),
        [{ body: 'old content' }, { body: 'migration 2 content' }],
      );
    } finally {
      failed.close(true);
    }
    assert.equal(
      (await readdir(directory)).some((name) => name.startsWith('.restore-')),
      false,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('bootstrap keeps the failed database quarantined and original path absent when recovery fails', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'migration-recovery-fail-'));
  const databasePath = join(directory, 'app.db');
  const first: Migration = {
    version: 1,
    name: 'first',
    source: 'create recovery probe',
    up(database) {
      database.exec('CREATE TABLE recovery_probe(value TEXT)');
    },
  };
  const failing: Migration = {
    version: 2,
    name: 'failing',
    source: 'fail recovery probe',
    up() {
      throw new Error('migration failed');
    },
  };
  const restoreError = new Error('injected restore failure');

  try {
    const initial = new Database(databasePath, { create: true });
    runMigrations(initial, [first]);
    initial.close(true);

    await assert.rejects(
      bootstrapMigrations(databasePath, {
        migrations: [first, failing],
        restoreBackup: () => {
          throw restoreError;
        },
      }),
      (error: unknown) => {
        assert.ok(error instanceof MigrationRecoveryError);
        assert.equal(error.code, 'migration_failed_recovery_failed');
        assert.ok(error.cause instanceof AggregateError);
        assert.equal(error.cause.errors.at(-1), restoreError);
        return true;
      },
    );
    await assert.rejects(access(databasePath));
    assert.equal(
      (await readdir(join(directory, 'migration-quarantine'))).length,
      1,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('bootstrap closes without quarantining when pre-migration backup creation fails', async () => {
  const backupError = new Error('backup failed');
  const events: string[] = [];
  await assert.rejects(
    bootstrapMigrations('/data/bootstrap.db', {
      mkdir: async () => undefined,
      inspectSchema: () => ({ initialized: false, version: 0 }),
      openDatabase: () => ({
        close: () => {
          events.push('close');
        },
      }),
      createBackup: () => {
        events.push('backup');
        throw backupError;
      },
      quarantineFailedDatabase: () => {
        events.push('quarantine');
        throw new Error('must not quarantine');
      },
    }),
    (error: unknown) =>
      error instanceof MigrationRecoveryError &&
      error.code === 'backup_failed' &&
      error.cause === backupError,
  );
  assert.deepEqual(events, ['backup', 'close']);
});

test('bootstrap fails closed without quarantine or restore when close fails', async () => {
  const migrationError = new Error('migration failed');
  const closeError = new Error('close failed');
  const events: string[] = [];
  const backup = {
    directoryPath: '/data/backups/backup',
    databasePath: '/data/backups/backup/colorful-code.db',
    manifestPath: '/data/backups/backup/manifest.json',
    manifest: {
      formatVersion: 1 as const,
      sourceDatabaseFile: 'bootstrap.db',
      sourceSchemaVersion: 0,
      targetSchemaVersion: 1,
      createdAt: '2026-07-14T00:00:00.000Z',
      databaseFile: 'colorful-code.db',
      sizeBytes: 1,
      sha256: '0'.repeat(64),
      integrityCheck: 'ok' as const,
      foreignKeyViolations: 0 as const,
    },
  };

  await assert.rejects(
    bootstrapMigrations('/data/bootstrap.db', {
      migrations: [migration(1, 'pending', 'SELECT 1')],
      mkdir: async () => undefined,
      inspectSchema: () => ({ initialized: false, version: 0 }),
      openDatabase: () => ({
        close: () => {
          events.push('close');
          throw closeError;
        },
      }),
      createBackup: () => {
        events.push('backup');
        return backup;
      },
      runMigrations: () => {
        events.push('migrate');
        throw migrationError;
      },
      quarantineFailedDatabase: () => {
        events.push('quarantine');
        return { directoryPath: '/data/quarantine/failed' };
      },
      restoreBackup: () => {
        events.push('restore');
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof MigrationRecoveryError);
      assert.equal(error.code, 'migration_failed_recovery_failed');
      assert.ok(error.cause instanceof AggregateError);
      assert.deepEqual(error.cause.errors, [migrationError, closeError]);
      return true;
    },
  );
  assert.deepEqual(events, ['backup', 'migrate', 'close']);
});

test('bootstrap restores when post-migration foreign key verification fails', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'migration-fk-recovery-'));
  const databasePath = join(directory, 'app.db');
  const invalidForeignKey: Migration = {
    version: 1,
    name: 'invalid_foreign_key',
    source: 'create invalid foreign key data',
    up(database) {
      database.exec('CREATE TABLE parents(id INTEGER PRIMARY KEY)');
      database.exec(
        'CREATE TABLE children(parent_id INTEGER REFERENCES parents(id))',
      );
      database.exec('INSERT INTO children VALUES (999)');
    },
  };

  try {
    await assert.rejects(
      bootstrapMigrations(databasePath, { migrations: [invalidForeignKey] }),
      (error: unknown) =>
        error instanceof MigrationRecoveryError &&
        error.code === 'migration_failed_recovered',
    );
    const restored = new Database(databasePath, { readonly: true });
    try {
      assert.equal(
        restored
          .query<
            { count: number },
            []
          >("SELECT count(*) AS count FROM sqlite_schema WHERE type = 'table'")
          .get()!.count,
        0,
      );
    } finally {
      restored.close(true);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('bootstrap closes its controlled connection exactly once after success', async () => {
  const closeArguments: unknown[] = [];
  const registry = [migration(1, 'controlled', 'SELECT 1')];
  const database = {
    close(force?: boolean): void {
      closeArguments.push(force);
    },
  };
  let receivedDatabase: unknown;
  let receivedMigrations: readonly Migration[] | undefined;

  await bootstrapMigrations('/data/bootstrap.db', {
    ...noPendingMigration(1),
    migrations: registry,
    mkdir: async () => undefined,
    openDatabase: (databasePath, options) => {
      assert.equal(databasePath, '/data/bootstrap.db');
      assert.deepEqual(options, { create: true, readwrite: true });
      return database;
    },
    runMigrations: (opened, migrations) => {
      receivedDatabase = opened;
      receivedMigrations = migrations;
    },
  });

  assert.equal(receivedDatabase, database);
  assert.notEqual(receivedMigrations, registry);
  assert.deepEqual(receivedMigrations, registry);
  assert.equal(Object.isFrozen(receivedMigrations), true);
  assert.deepEqual(closeArguments, [true]);
});

test('bootstrap preserves migration failure and closes exactly once', async () => {
  const migrationError = new Error('migration failed');
  const closeArguments: unknown[] = [];

  await assert.rejects(
    bootstrapMigrations('/data/bootstrap.db', {
      ...noPendingMigration(),
      mkdir: async () => undefined,
      openDatabase: () => ({
        close(force?: boolean): void {
          closeArguments.push(force);
        },
      }),
      runMigrations: () => {
        throw migrationError;
      },
    }),
    (error) => error === migrationError,
  );

  assert.deepEqual(closeArguments, [true]);
});

test('bootstrap aggregates migration and close failures in primary-first order', async () => {
  const migrationError = new Error('migration failed');
  const closeError = new Error('close failed');

  await assert.rejects(
    bootstrapMigrations('/data/bootstrap.db', {
      ...noPendingMigration(),
      mkdir: async () => undefined,
      openDatabase: () => ({
        close: async () => {
          throw closeError;
        },
      }),
      runMigrations: () => {
        throw migrationError;
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [migrationError, closeError]);
      return true;
    },
  );
});

test('bootstrap does not lose an undefined migration failure when close also fails', async () => {
  const closeError = new Error('close failed');

  await assert.rejects(
    bootstrapMigrations('/data/bootstrap.db', {
      ...noPendingMigration(),
      mkdir: async () => undefined,
      openDatabase: () => ({
        close: async () => {
          throw closeError;
        },
      }),
      runMigrations: () => {
        throw undefined;
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [undefined, closeError]);
      return true;
    },
  );
});

test('bootstrap throws a close failure after successful migration', async () => {
  const closeError = new Error('close failed');

  await assert.rejects(
    bootstrapMigrations('/data/bootstrap.db', {
      ...noPendingMigration(),
      mkdir: async () => undefined,
      openDatabase: () => ({
        close: () => {
          throw closeError;
        },
      }),
      runMigrations: () => undefined,
    }),
    (error) => error === closeError,
  );
});

test('bootstrap awaits an asynchronous close before completing', async () => {
  let finishClose: () => void = () => undefined;
  const closeGate = new Promise<void>((resolve) => {
    finishClose = resolve;
  });
  let completed = false;

  const bootstrapping = bootstrapMigrations('/data/bootstrap.db', {
    ...noPendingMigration(),
    mkdir: async () => undefined,
    openDatabase: () => ({ close: async () => closeGate }),
    runMigrations: () => undefined,
  }).then(() => {
    completed = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(completed, false);
  finishClose();
  await bootstrapping;
  assert.equal(completed, true);
});

test('bootstrap throws an asynchronous close rejection after migration succeeds', async () => {
  const closeError = new Error('async close failed');

  await assert.rejects(
    bootstrapMigrations('/data/bootstrap.db', {
      ...noPendingMigration(),
      mkdir: async () => undefined,
      openDatabase: () => ({
        close: async () => {
          throw closeError;
        },
      }),
      runMigrations: () => undefined,
    }),
    (error) => error === closeError,
  );
});

test('bootstrap aggregates a migration rejection with asynchronous close rejection', async () => {
  const migrationError = new Error('async migration failed');
  const closeError = new Error('async close failed');

  await assert.rejects(
    bootstrapMigrations('/data/bootstrap.db', {
      ...noPendingMigration(),
      mkdir: async () => undefined,
      openDatabase: () => ({
        close: async () => {
          throw closeError;
        },
      }),
      runMigrations: async () => {
        throw migrationError;
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [migrationError, closeError]);
      return true;
    },
  );
});

for (const databasePath of [
  'file::memory:evil',
  'file:/tmp/alias.db',
  'FILE:/tmp/alias.db',
  'file://user:secret@localhost/private.db',
]) {
  test(`bootstrap rejects unsupported database URI ${databasePath} before I/O`, async () => {
    let mkdirCalls = 0;
    let openCalls = 0;
    let migrationCalls = 0;

    await assert.rejects(
      bootstrapMigrations(databasePath, {
        mkdir: async () => {
          mkdirCalls += 1;
        },
        openDatabase: () => {
          openCalls += 1;
          return { close: () => undefined };
        },
        runMigrations: () => {
          migrationCalls += 1;
        },
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.name, 'DatabasePathError');
        assert.doesNotMatch(
          JSON.stringify(error, Object.getOwnPropertyNames(error)),
          /user|secret|private\.db/,
        );
        return true;
      },
    );

    assert.equal(mkdirCalls, 0);
    assert.equal(openCalls, 0);
    assert.equal(migrationCalls, 0);
  });
}

test('bootstrap rejects an existing symbolic-link database before opening it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'colorful-code-symlink-'));
  const targetPath = join(directory, 'target.db');
  const linkPath = join(directory, 'link.db');
  let openCalls = 0;

  try {
    await writeFile(targetPath, '');
    await symlink(targetPath, linkPath);

    await assert.rejects(
      bootstrapMigrations(linkPath, {
        openDatabase: () => {
          openCalls += 1;
          return { close: () => undefined };
        },
        runMigrations: () => undefined,
      }),
      (error: unknown) =>
        error instanceof Error && error.name === 'DatabasePathError',
    );

    assert.equal(openCalls, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

for (const databasePath of [
  '',
  ':memory:',
  'file::memory:',
  'file::memory:?cache=shared',
]) {
  test(`bootstrap rejects unsupported in-memory path ${JSON.stringify(databasePath)} before I/O`, async () => {
    let mkdirCalls = 0;
    let openCalls = 0;
    let migrationCalls = 0;

    await assert.rejects(
      bootstrapMigrations(databasePath, {
        mkdir: async () => {
          mkdirCalls += 1;
        },
        openDatabase: () => {
          openCalls += 1;
          return { close: () => undefined };
        },
        runMigrations: () => {
          migrationCalls += 1;
        },
      }),
      (error: unknown) =>
        error instanceof Error &&
        error.name === 'DatabasePathError' &&
        (error as Error & { code?: unknown }).code ===
          'in_memory_database_unsupported',
    );

    assert.equal(mkdirCalls, 0);
    assert.equal(openCalls, 0);
    assert.equal(migrationCalls, 0);
  });
}

test('migration checksum is stable lowercase SHA-256', () => {
  const entry = migration(1, 'create_users', 'CREATE TABLE users(id INTEGER);');

  assert.equal(migrationChecksum(entry), migrationChecksum({ ...entry }));
  assert.match(migrationChecksum(entry), /^[0-9a-f]{64}$/);
});

test('migration checksum encoding has no field-boundary ambiguity', () => {
  const first = migration(1, 'ab', 'c');
  const second = migration(1, 'a', 'bc');

  assert.notEqual(migrationChecksum(first), migrationChecksum(second));
});

test('registry rejects non-positive, non-integer, and non-increasing versions', () => {
  for (const registry of [
    [migration(0, 'zero', 'sql')],
    [migration(1.5, 'fraction', 'sql')],
    [migration(2, 'second', 'sql'), migration(1, 'first', 'sql')],
  ]) {
    assert.throws(
      () => validateMigrationRegistry(registry),
      (error) =>
        error instanceof MigrationError && error.code === 'invalid_registry',
    );
  }
});

test('registry rejects empty and duplicate names', () => {
  for (const registry of [
    [migration(1, '', 'sql')],
    [migration(1, 'same', 'sql'), migration(2, 'same', 'other sql')],
  ]) {
    assert.throws(
      () => validateMigrationRegistry(registry),
      (error) =>
        error instanceof MigrationError && error.code === 'invalid_registry',
    );
  }
});

test('registry rejects empty migration source', () => {
  assert.throws(
    () => validateMigrationRegistry([migration(1, 'one', '')]),
    (error) =>
      error instanceof MigrationError && error.code === 'invalid_registry',
  );
});

test('empty database applies migrations in order and records complete metadata', async () => {
  await withDatabase((database) => {
    const calls: number[] = [];
    const registry: Migration[] = [
      {
        version: 1,
        name: 'create_alpha',
        source: 'CREATE TABLE alpha(id INTEGER);',
        up(db) {
          calls.push(1);
          assert(Object.isFrozen(db));
          assert.deepEqual(Object.keys(db), ['exec']);
          db.exec(this.source);
        },
      },
      {
        version: 2,
        name: 'create_beta',
        source: 'CREATE TABLE beta(id INTEGER);',
        up(db) {
          calls.push(2);
          db.exec(this.source);
        },
      },
    ];
    const monotonicTimes = [10.9, 13.8, 20.1, 19.2];

    runMigrations(database, registry, {
      now: () => 1_234.9,
      monotonicNow: () => monotonicTimes.shift()!,
    });

    assert.deepEqual(calls, [1, 2]);
    assert.deepEqual(
      database
        .query<
          {
            version: number;
            name: string;
            checksum: string;
            applied_at: number;
            duration_ms: number;
          },
          []
        >(
          `SELECT version, name, checksum, applied_at, duration_ms
           FROM schema_migrations ORDER BY version`,
        )
        .all(),
      [
        {
          version: 1,
          name: 'create_alpha',
          checksum: migrationChecksum(registry[0]!),
          applied_at: 1234,
          duration_ms: 2,
        },
        {
          version: 2,
          name: 'create_beta',
          checksum: migrationChecksum(registry[1]!),
          applied_at: 1234,
          duration_ms: 0,
        },
      ],
    );
    assert.match(
      database
        .query<
          { sql: string },
          [string]
        >('SELECT sql FROM sqlite_schema WHERE name = ?')
        .get('schema_migrations')!.sql,
      /STRICT\s*$/i,
    );
  });
});

test('repeated migration run does not call already applied migrations', async () => {
  await withDatabase((database) => {
    let calls = 0;
    const registry: Migration[] = [
      {
        version: 1,
        name: 'once',
        source: 'CREATE TABLE once_only(id INTEGER);',
        up(db) {
          calls += 1;
          db.exec(this.source);
        },
      },
    ];

    runMigrations(database, registry);
    runMigrations(database, registry);

    assert.equal(calls, 1);
    assert.equal(
      database
        .query<
          { count: number },
          []
        >('SELECT count(*) AS count FROM schema_migrations')
        .get()!.count,
      1,
    );
  });
});

test('migration execution uses an immutable registry snapshot', async () => {
  await withDatabase((database) => {
    const calls: string[] = [];
    const registry: Migration[] = [];
    const late = migration(3, 'late', 'CREATE TABLE late_table(id INTEGER);');
    late.up = () => void calls.push('late');
    const second = migration(
      2,
      'second',
      'CREATE TABLE snapshot_second(id INTEGER);',
    );
    second.up = (db) => {
      calls.push('second');
      db.exec('CREATE TABLE snapshot_second(id INTEGER);');
    };
    const first = migration(
      1,
      'first',
      'CREATE TABLE snapshot_first(id INTEGER);',
    );
    first.up = (db) => {
      calls.push('first');
      Object.assign(
        first as { version: number; name: string; source: string },
        {
          version: 99,
          name: 'mutated_first',
          source: 'mutated first source',
        },
      );
      Object.assign(
        second as { version: number; name: string; source: string },
        {
          version: 100,
          name: 'mutated_second',
          source: 'mutated second source',
        },
      );
      registry.push(late);
      db.exec('CREATE TABLE snapshot_first(id INTEGER);');
    };
    registry.push(first, second);
    const expectedChecksums = [
      migrationChecksum(first),
      migrationChecksum(second),
    ];

    runMigrations(database, registry);

    assert.deepEqual(calls, ['first', 'second']);
    assert.deepEqual(
      database
        .query<
          { version: number; name: string; checksum: string },
          []
        >('SELECT version, name, checksum FROM schema_migrations ORDER BY version')
        .all(),
      [
        { version: 1, name: 'first', checksum: expectedChecksums[0] },
        { version: 2, name: 'second', checksum: expectedChecksums[1] },
      ],
    );
    assert.equal(
      database
        .query<
          { count: number },
          [string]
        >("SELECT count(*) AS count FROM sqlite_schema WHERE type = 'table' AND name = ?")
        .get('late_table')!.count,
      0,
    );
  });
});

test('registry fields are captured from getters exactly once', async () => {
  await withDatabase((database) => {
    const reads = { version: 0, name: 0, source: 0, up: 0 };
    const entry = {
      get version() {
        reads.version += 1;
        return reads.version === 1 ? 1 : 0;
      },
      get name() {
        reads.name += 1;
        return reads.name === 1 ? 'getter_migration' : '';
      },
      get source() {
        reads.source += 1;
        return reads.source === 1
          ? 'CREATE TABLE getter_table(id INTEGER);'
          : '';
      },
      get up() {
        reads.up += 1;
        return reads.up === 1
          ? (db: Parameters<Migration['up']>[0]) =>
              db.exec('CREATE TABLE getter_table(id INTEGER);')
          : undefined;
      },
    } as unknown as Migration;

    runMigrations(database, [entry]);

    assert.deepEqual(reads, { version: 1, name: 1, source: 1, up: 1 });
    assert.deepEqual(
      database
        .query<
          { version: number; name: string },
          []
        >('SELECT version, name FROM schema_migrations')
        .all(),
      [{ version: 1, name: 'getter_migration' }],
    );
  });
});

test('checksum drift is rejected before any pending migration runs', async () => {
  await withDatabase((database) => {
    runMigrations(database, [migration(1, 'first', 'original source')]);
    let pendingCalls = 0;

    assert.throws(
      () =>
        runMigrations(database, [
          migration(1, 'first', 'changed source'),
          {
            ...migration(2, 'pending', 'SELECT 2'),
            up: () => void (pendingCalls += 1),
          },
        ]),
      (error) =>
        error instanceof MigrationError &&
        error.code === 'checksum_mismatch' &&
        error.version === 1 &&
        error.migrationName === 'first',
    );
    assert.equal(pendingCalls, 0);
  });
});

test('database newer than program is rejected before any pending migration runs', async () => {
  await withDatabase((database) => {
    runMigrations(database, []);
    database
      .query(
        `INSERT INTO schema_migrations
           (version, name, checksum, applied_at, duration_ms)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(3, 'future', 'f'.repeat(64), 0, 0);
    let pendingCalls = 0;

    assert.throws(
      () =>
        runMigrations(database, [
          {
            ...migration(1, 'pending', 'SELECT 1'),
            up: () => void (pendingCalls += 1),
          },
        ]),
      (error) =>
        error instanceof MigrationError &&
        error.code === 'database_newer_than_program' &&
        error.version === 3,
    );
    assert.equal(pendingCalls, 0);
  });
});

test('unknown applied version is rejected before any pending migration runs', async () => {
  await withDatabase((database) => {
    runMigrations(database, []);
    database
      .query(
        `INSERT INTO schema_migrations
           (version, name, checksum, applied_at, duration_ms)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(2, 'unknown', 'e'.repeat(64), 0, 0);
    let pendingCalls = 0;

    assert.throws(
      () =>
        runMigrations(database, [
          migration(1, 'first', 'SELECT 1'),
          {
            ...migration(3, 'pending', 'SELECT 3'),
            up: () => void (pendingCalls += 1),
          },
        ]),
      (error) =>
        error instanceof MigrationError &&
        error.code === 'unknown_applied_migration' &&
        error.version === 2 &&
        error.migrationName === 'unknown',
    );
    assert.equal(pendingCalls, 0);
  });
});

test('applied name mismatch is rejected before any pending migration runs', async () => {
  await withDatabase((database) => {
    const original = migration(1, 'original_name', 'SELECT 1');
    runMigrations(database, [original]);
    database
      .query('UPDATE schema_migrations SET name = ? WHERE version = ?')
      .run('wrong_name', 1);
    let pendingCalls = 0;

    assert.throws(
      () =>
        runMigrations(database, [
          original,
          {
            ...migration(2, 'pending', 'SELECT 2'),
            up: () => void (pendingCalls += 1),
          },
        ]),
      (error) =>
        error instanceof MigrationError &&
        error.code === 'unknown_applied_migration' &&
        error.version === 1 &&
        error.migrationName === 'wrong_name',
    );
    assert.equal(pendingCalls, 0);
  });
});

test('applied history missing its first registry entry fails closed', async () => {
  await withDatabase((database) => {
    const registry = [
      migration(1, 'first', 'SELECT 1'),
      migration(2, 'second', 'SELECT 2'),
      migration(3, 'third', 'SELECT 3'),
    ];
    runMigrations(database, registry);
    database.query('DELETE FROM schema_migrations WHERE version = ?').run(1);
    let pendingCalls = 0;
    registry[0]!.up = () => void (pendingCalls += 1);

    assert.throws(
      () => runMigrations(database, registry),
      (error) =>
        error instanceof MigrationError &&
        error.code === 'unknown_applied_migration',
    );
    assert.equal(pendingCalls, 0);
    assert.deepEqual(
      database
        .query<
          { version: number },
          []
        >('SELECT version FROM schema_migrations ORDER BY version')
        .all(),
      [{ version: 2 }, { version: 3 }],
    );
  });
});

test('applied history with an internal registry gap fails closed', async () => {
  await withDatabase((database) => {
    const registry = [
      migration(1, 'first', 'SELECT 1'),
      migration(2, 'second', 'SELECT 2'),
      migration(3, 'third', 'SELECT 3'),
    ];
    runMigrations(database, registry);
    database.query('DELETE FROM schema_migrations WHERE version = ?').run(2);
    let pendingCalls = 0;
    registry[1]!.up = () => void (pendingCalls += 1);

    assert.throws(
      () => runMigrations(database, registry),
      (error) =>
        error instanceof MigrationError &&
        error.code === 'unknown_applied_migration',
    );
    assert.equal(pendingCalls, 0);
    assert.deepEqual(
      database
        .query<
          { version: number },
          []
        >('SELECT version FROM schema_migrations ORDER BY version')
        .all(),
      [{ version: 1 }, { version: 3 }],
    );
  });
});

test('duplicate applied versions in malformed metadata fail closed', async () => {
  await withDatabase((database) => {
    database.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER NOT NULL,
        name TEXT NOT NULL,
        checksum TEXT NOT NULL,
        applied_at INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL
      );
    `);
    const first = migration(1, 'first', 'SELECT 1');
    const insert = database.query(
      `INSERT INTO schema_migrations
         (version, name, checksum, applied_at, duration_ms)
       VALUES (?, ?, ?, ?, ?)`,
    );
    insert.run(1, first.name, migrationChecksum(first), 0, 0);
    insert.run(1, first.name, migrationChecksum(first), 0, 0);
    let pendingCalls = 0;

    assert.throws(
      () =>
        runMigrations(database, [
          first,
          {
            ...migration(2, 'pending', 'SELECT 2'),
            up: () => void (pendingCalls += 1),
          },
        ]),
      (error) =>
        error instanceof MigrationError &&
        error.code === 'migration_metadata_invalid',
    );
    assert.equal(pendingCalls, 0);
    assert.equal(
      database
        .query<
          { count: number },
          []
        >('SELECT count(*) AS count FROM schema_migrations')
        .get()!.count,
      2,
    );
  });
});

test('non-STRICT metadata table without required keys fails before pending migrations', async () => {
  await withDatabase((database) => {
    database.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER,
        name TEXT,
        checksum TEXT,
        applied_at INTEGER,
        duration_ms INTEGER
      );
    `);
    const first = migration(1, 'first', 'SELECT 1');
    database
      .query(
        `INSERT INTO schema_migrations
           (version, name, checksum, applied_at, duration_ms)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(1, first.name, migrationChecksum(first), 0, 0);
    let pendingCalls = 0;

    assert.throws(
      () =>
        runMigrations(database, [
          first,
          {
            ...migration(2, 'pending', 'SELECT 2'),
            up: () => void (pendingCalls += 1),
          },
        ]),
      (error) =>
        error instanceof MigrationError &&
        error.code === 'migration_metadata_invalid',
    );
    assert.equal(pendingCalls, 0);
  });
});

test('partial unique name index does not satisfy metadata identity', async () => {
  await withDatabase((database) => {
    database.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        checksum TEXT NOT NULL,
        applied_at INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL
      ) STRICT;
      CREATE UNIQUE INDEX partial_name_unique
        ON schema_migrations(name) WHERE version > 100;
    `);
    const first = migration(1, 'first', 'SELECT 1');
    database
      .query(
        `INSERT INTO schema_migrations
           (version, name, checksum, applied_at, duration_ms)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(1, first.name, migrationChecksum(first), 0, 0);
    let pendingCalls = 0;

    assert.throws(
      () =>
        runMigrations(database, [
          first,
          {
            ...migration(2, 'pending', 'SELECT 2'),
            up: () => void (pendingCalls += 1),
          },
        ]),
      (error) =>
        error instanceof MigrationError &&
        error.code === 'migration_metadata_invalid',
    );
    assert.equal(pendingCalls, 0);
  });
});

test('metadata schema inspection errors are wrapped as metadata invalid', async () => {
  await withDatabase((database) => {
    database.exec('CREATE VIEW schema_migrations AS SELECT 1 AS version;');

    assert.throws(
      () => runMigrations(database, []),
      (error) =>
        error instanceof MigrationError &&
        error.code === 'migration_metadata_invalid',
    );
  });
});

test('invalid applied migration records fail before pending migrations', async () => {
  const invalidRows: Array<[number, string, string, number, number]> = [
    [0, 'first', 'a'.repeat(64), 0, 0],
    [Number.MAX_SAFE_INTEGER + 1, 'first', 'a'.repeat(64), 0, 0],
    [1, '', 'a'.repeat(64), 0, 0],
    [1, 'first', 'NOT-A-CHECKSUM', 0, 0],
    [1, 'first', 'a'.repeat(64), -1, 0],
    [1, 'first', 'a'.repeat(64), 0, -1],
  ];

  for (const row of invalidRows) {
    await withDatabase((database) => {
      runMigrations(database, []);
      database
        .query(
          `INSERT INTO schema_migrations
             (version, name, checksum, applied_at, duration_ms)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(...row);
      let pendingCalls = 0;

      assert.throws(
        () =>
          runMigrations(database, [
            {
              ...migration(1, 'pending', 'SELECT 1'),
              up: () => void (pendingCalls += 1),
            },
          ]),
        (error) =>
          error instanceof MigrationError &&
          error.code === 'migration_metadata_invalid',
      );
      assert.equal(pendingCalls, 0);
    });
  }
});

test('failed migration rolls back, stops, and resumes after repair', async () => {
  await withDatabase((database) => {
    const cause = new Error('deliberate failure');
    const first = migration(
      1,
      'first',
      'CREATE TABLE first_table(id INTEGER);',
    );
    first.up = (db) => db.exec(first.source);
    const failing = migration(
      2,
      'second',
      'CREATE TABLE second_table(id INTEGER);',
    );
    failing.up = (db) => {
      db.exec(failing.source);
      throw cause;
    };
    let thirdCalls = 0;
    const third = migration(
      3,
      'third',
      'CREATE TABLE third_table(id INTEGER);',
    );
    third.up = (db) => {
      thirdCalls += 1;
      db.exec(third.source);
    };

    assert.throws(
      () => runMigrations(database, [first, failing, third]),
      (error) =>
        error instanceof MigrationError &&
        error.code === 'migration_failed' &&
        error.version === 2 &&
        error.migrationName === 'second' &&
        error.cause === cause,
    );
    assert.equal(thirdCalls, 0);
    assert.deepEqual(
      database
        .query<
          { version: number },
          []
        >('SELECT version FROM schema_migrations ORDER BY version')
        .all(),
      [{ version: 1 }],
    );
    assert.equal(
      database
        .query<
          { count: number },
          [string]
        >("SELECT count(*) AS count FROM sqlite_schema WHERE type = 'table' AND name = ?")
        .get('first_table')!.count,
      1,
    );
    assert.equal(
      database
        .query<
          { count: number },
          [string]
        >("SELECT count(*) AS count FROM sqlite_schema WHERE type = 'table' AND name = ?")
        .get('second_table')!.count,
      0,
    );

    const repaired = {
      ...failing,
      up: (db) => db.exec(failing.source),
    } satisfies Migration;
    runMigrations(database, [first, repaired, third]);

    assert.equal(thirdCalls, 1);
    assert.deepEqual(
      database
        .query<
          { version: number },
          []
        >('SELECT version FROM schema_migrations ORDER BY version')
        .all(),
      [{ version: 1 }, { version: 2 }, { version: 3 }],
    );
    for (const table of ['second_table', 'third_table']) {
      assert.equal(
        database
          .query<
            { count: number },
            [string]
          >("SELECT count(*) AS count FROM sqlite_schema WHERE type = 'table' AND name = ?")
          .get(table)!.count,
        1,
      );
    }
  });
});

test('migration exec rejects COMMIT before any statement can escape rollback', async () => {
  await withDatabase((database) => {
    const entry = migration(1, 'commit_escape', 'commit escape attempt');
    entry.up = (db) => {
      db.exec('CREATE TABLE escaped_commit(id INTEGER); COMMIT;');
      throw new Error('after commit');
    };

    assert.throws(
      () => runMigrations(database, [entry]),
      (error) =>
        error instanceof MigrationError && error.code === 'migration_failed',
    );
    assert.equal(
      database
        .query<
          { count: number },
          []
        >('SELECT count(*) AS count FROM schema_migrations')
        .get()!.count,
      0,
    );
    assert.equal(
      database
        .query<
          { count: number },
          [string]
        >("SELECT count(*) AS count FROM sqlite_schema WHERE type = 'table' AND name = ?")
        .get('escaped_commit')!.count,
      0,
    );
  });
});

test('migration exec rejects ROLLBACK before a trailing statement can escape', async () => {
  await withDatabase((database) => {
    const entry = migration(1, 'rollback_escape', 'rollback escape attempt');
    entry.up = (db) => {
      db.exec('ROLLBACK; CREATE TABLE escaped_rollback(id INTEGER);');
    };

    assert.throws(
      () => runMigrations(database, [entry]),
      (error) =>
        error instanceof MigrationError && error.code === 'migration_failed',
    );
    assert.equal(
      database
        .query<
          { count: number },
          []
        >('SELECT count(*) AS count FROM schema_migrations')
        .get()!.count,
      0,
    );
    assert.equal(
      database
        .query<
          { count: number },
          [string]
        >("SELECT count(*) AS count FROM sqlite_schema WHERE type = 'table' AND name = ?")
        .get('escaped_rollback')!.count,
      0,
    );
  });
});

test('migration exec rejects multiple legal statements without executing a partial migration', async () => {
  await withDatabase((database) => {
    const entry = migration(
      1,
      'multiple_statements',
      'multiple statement attempt',
    );
    entry.up = (db) => {
      db.exec(
        'CREATE TABLE partial_one(id INTEGER); CREATE TABLE partial_two(id INTEGER);',
      );
    };

    assert.throws(
      () => runMigrations(database, [entry]),
      (error) =>
        error instanceof MigrationError && error.code === 'migration_failed',
    );
    assert.equal(
      database
        .query<
          { count: number },
          []
        >('SELECT count(*) AS count FROM schema_migrations')
        .get()!.count,
      0,
    );
    for (const table of ['partial_one', 'partial_two']) {
      assert.equal(
        database
          .query<
            { count: number },
            [string]
          >("SELECT count(*) AS count FROM sqlite_schema WHERE type = 'table' AND name = ?")
          .get(table)!.count,
        0,
      );
    }
  });
});

test('migration exec accepts a single CREATE TRIGGER statement with a BEGIN END body', async () => {
  await withDatabase((database) => {
    const entry = migration(1, 'create_trigger', 'create table and trigger');
    entry.up = (db) => {
      db.exec('CREATE TABLE trigger_source(value INTEGER);');
      db.exec(`
        CREATE TRIGGER trigger_body AFTER INSERT ON trigger_source
        BEGIN
          UPDATE trigger_source SET value = value + 1;
          UPDATE trigger_source SET value = value + 1;
        END;
      `);
    };

    runMigrations(database, [entry]);

    assert.equal(
      database
        .query<
          { count: number },
          [string]
        >("SELECT count(*) AS count FROM sqlite_schema WHERE type = 'trigger' AND name = ?")
        .get('trigger_body')!.count,
      1,
    );
  });
});

test('migration exec finalizes its prepared statement after execution', async () => {
  await withDatabase((database) => {
    const originalPrepare = database.prepare.bind(database);
    let captured: ReturnType<Database['prepare']> | undefined;
    Object.defineProperty(database, 'prepare', {
      configurable: true,
      value(sql: string) {
        const statement = originalPrepare(sql);
        if (sql.includes('finalized_probe')) captured = statement;
        return statement;
      },
    });
    const entry = migration(1, 'finalize_statement', 'SELECT 1');
    entry.up = (db) => db.exec('SELECT 1 /* finalized_probe */;');

    try {
      runMigrations(database, [entry]);
    } finally {
      delete (database as unknown as { prepare?: unknown }).prepare;
    }

    if (captured === undefined) throw new Error('Statement was not captured');
    const finalized = captured;
    assert.throws(() => finalized.run(), /Statement has finalized/);
  });
});

test('async migration is rejected and its DDL is rolled back', async () => {
  await withDatabase((database) => {
    const asyncMigration: Migration = {
      version: 1,
      name: 'async_not_allowed',
      source: 'CREATE TABLE async_table(id INTEGER);',
      async up(db) {
        db.exec(this.source);
      },
    };

    assert.throws(
      () => runMigrations(database, [asyncMigration]),
      (error) =>
        error instanceof MigrationError &&
        error.code === 'migration_failed' &&
        error.cause instanceof TypeError &&
        /synchronous/i.test(error.cause.message),
    );
    assert.equal(
      database
        .query<
          { count: number },
          []
        >('SELECT count(*) AS count FROM schema_migrations')
        .get()!.count,
      0,
    );
    assert.equal(
      database
        .query<
          { count: number },
          [string]
        >("SELECT count(*) AS count FROM sqlite_schema WHERE type = 'table' AND name = ?")
        .get('async_table')!.count,
      0,
    );
  });
});

test('async migration cannot write through its facade after synchronous rejection', async () => {
  await withDatabase(async (database) => {
    const unhandled: unknown[] = [];
    const onUnhandledRejection = (reason: unknown): void => {
      unhandled.push(reason);
    };
    const asyncMigration: Migration = {
      version: 1,
      name: 'late_async_write',
      source: 'CREATE TABLE late_write(id INTEGER);',
      async up(db) {
        await Promise.resolve();
        db.exec(this.source);
      },
    };

    process.on('unhandledRejection', onUnhandledRejection);
    try {
      assert.throws(
        () => runMigrations(database, [asyncMigration]),
        (error) =>
          error instanceof MigrationError && error.code === 'migration_failed',
      );
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
    }

    assert.deepEqual(unhandled, []);
    assert.equal(
      database
        .query<
          { count: number },
          []
        >('SELECT count(*) AS count FROM schema_migrations')
        .get()!.count,
      0,
    );
    assert.equal(
      database
        .query<
          { count: number },
          [string]
        >("SELECT count(*) AS count FROM sqlite_schema WHERE type = 'table' AND name = ?")
        .get('late_write')!.count,
      0,
    );
  });
});

test('thenable observer reads a Promise then getter only once', async () => {
  await withDatabase(async (database) => {
    const unhandled: unknown[] = [];
    const onUnhandledRejection = (reason: unknown): void => {
      unhandled.push(reason);
    };
    const getterSentinel = new Error('then getter read twice');
    const rejection = new Error('already rejected');
    let getterReads = 0;
    const entry = migration(
      1,
      'single_then_read',
      'CREATE TABLE should_not_exist(id INTEGER);',
    );
    entry.up = () => {
      const promise = Promise.reject(rejection);
      Object.defineProperty(promise, 'then', {
        configurable: true,
        get() {
          getterReads += 1;
          if (getterReads > 1) throw getterSentinel;
          return Promise.prototype.then;
        },
      });
      return promise;
    };

    process.on('unhandledRejection', onUnhandledRejection);
    try {
      assert.throws(
        () => runMigrations(database, [entry]),
        (error) =>
          error instanceof MigrationError &&
          error.code === 'migration_failed' &&
          error.cause instanceof TypeError &&
          /synchronous/i.test(error.cause.message),
      );
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
    }

    assert.equal(getterReads, 1);
    assert.deepEqual(unhandled, []);
    assert.equal(
      database
        .query<
          { count: number },
          []
        >('SELECT count(*) AS count FROM schema_migrations')
        .get()!.count,
      0,
    );
  });
});

test('migration facade is revoked after a successful migration returns', async () => {
  await withDatabase((database) => {
    let leakedFacade: Parameters<Migration['up']>[0] | undefined;
    const entry = migration(1, 'leak_attempt', 'SELECT 1');
    entry.up = (db) => {
      leakedFacade = db;
    };

    runMigrations(database, [entry]);

    assert.throws(
      () => leakedFacade!.exec('CREATE TABLE leaked_write(id INTEGER);'),
      (error) => error instanceof TypeError && /active/i.test(error.message),
    );
    assert.equal(
      database
        .query<
          { count: number },
          [string]
        >("SELECT count(*) AS count FROM sqlite_schema WHERE type = 'table' AND name = ?")
        .get('leaked_write')!.count,
      0,
    );
  });
});

test('non-finite wall-clock time fails clearly without metadata or DDL', async () => {
  for (const invalidTime of [Number.NaN, Number.POSITIVE_INFINITY]) {
    await withDatabase((database) => {
      const entry = migration(
        1,
        'bad_wall_clock',
        'CREATE TABLE bad_wall_clock(id INTEGER);',
      );
      entry.up = (db) => db.exec(entry.source);

      assert.throws(
        () => runMigrations(database, [entry], { now: () => invalidTime }),
        (error) =>
          error instanceof MigrationError &&
          error.code === 'migration_failed' &&
          error.cause instanceof RangeError &&
          /finite/i.test(error.cause.message),
      );
      assert.equal(
        database
          .query<
            { count: number },
            []
          >('SELECT count(*) AS count FROM schema_migrations')
          .get()!.count,
        0,
      );
      assert.equal(
        database
          .query<
            { count: number },
            [string]
          >("SELECT count(*) AS count FROM sqlite_schema WHERE type = 'table' AND name = ?")
          .get('bad_wall_clock')!.count,
        0,
      );
    });
  }
});

test('negative floored applied time fails clearly without metadata or DDL', async () => {
  await withDatabase((database) => {
    const entry = migration(
      1,
      'negative_applied_at',
      'CREATE TABLE negative_applied_at(id INTEGER);',
    );
    entry.up = (db) => db.exec(entry.source);

    assert.throws(
      () => runMigrations(database, [entry], { now: () => -0.1 }),
      (error) =>
        error instanceof MigrationError &&
        error.code === 'migration_failed' &&
        error.cause instanceof RangeError &&
        /non-negative safe integer/i.test(error.cause.message),
    );
    assert.equal(
      database
        .query<
          { count: number },
          []
        >('SELECT count(*) AS count FROM schema_migrations')
        .get()!.count,
      0,
    );
    assert.equal(
      database
        .query<
          { count: number },
          [string]
        >("SELECT count(*) AS count FROM sqlite_schema WHERE type = 'table' AND name = ?")
        .get('negative_applied_at')!.count,
      0,
    );
  });
});

test('non-finite monotonic time fails clearly without metadata or DDL', async () => {
  for (const readings of [
    [Number.NaN, 1],
    [0, Number.POSITIVE_INFINITY],
  ]) {
    await withDatabase((database) => {
      const entry = migration(
        1,
        'bad_monotonic',
        'CREATE TABLE bad_monotonic(id INTEGER);',
      );
      entry.up = (db) => db.exec(entry.source);
      const clock = [...readings];

      assert.throws(
        () =>
          runMigrations(database, [entry], {
            monotonicNow: () => clock.shift()!,
          }),
        (error) =>
          error instanceof MigrationError &&
          error.code === 'migration_failed' &&
          error.cause instanceof RangeError &&
          /finite/i.test(error.cause.message),
      );
      assert.equal(
        database
          .query<
            { count: number },
            []
          >('SELECT count(*) AS count FROM schema_migrations')
          .get()!.count,
        0,
      );
      assert.equal(
        database
          .query<
            { count: number },
            [string]
          >("SELECT count(*) AS count FROM sqlite_schema WHERE type = 'table' AND name = ?")
          .get('bad_monotonic')!.count,
        0,
      );
    });
  }
});

test('overflowing or unsafe duration fails clearly without metadata or DDL', async () => {
  for (const readings of [
    [-Number.MAX_VALUE, Number.MAX_VALUE],
    [0, Number.MAX_SAFE_INTEGER + 1],
  ]) {
    await withDatabase((database) => {
      const entry = migration(
        1,
        'bad_duration',
        'CREATE TABLE bad_duration(id INTEGER);',
      );
      entry.up = (db) => db.exec(entry.source);
      const clock = [...readings];

      assert.throws(
        () =>
          runMigrations(database, [entry], {
            monotonicNow: () => clock.shift()!,
          }),
        (error) =>
          error instanceof MigrationError &&
          error.code === 'migration_failed' &&
          error.cause instanceof RangeError &&
          /non-negative safe integer/i.test(error.cause.message),
      );
      assert.equal(
        database
          .query<
            { count: number },
            []
          >('SELECT count(*) AS count FROM schema_migrations')
          .get()!.count,
        0,
      );
      assert.equal(
        database
          .query<
            { count: number },
            [string]
          >("SELECT count(*) AS count FROM sqlite_schema WHERE type = 'table' AND name = ?")
          .get('bad_duration')!.count,
        0,
      );
    });
  }
});
