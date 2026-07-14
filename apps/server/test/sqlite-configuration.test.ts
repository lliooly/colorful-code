import { strict as assert } from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Database } from 'bun:sqlite';
import {
  configureSqliteConnection,
  SqliteConfigurationError,
  type SqliteConnectionRole,
} from '../src/persistence/sqlite-configuration';
import { createSqliteDiagnostics } from '../src/persistence/sqlite-diagnostics';
import {
  checkpointWal,
  WalCheckpointError,
} from '../src/persistence/sqlite-checkpoint';

async function withDatabasePath(
  run: (databasePath: string) => void | Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'colorful-code-sqlite-'));
  try {
    await run(join(directory, 'database.sqlite'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function pragmaNumber(database: Database, name: string): number {
  const row = database.query(`PRAGMA ${name}`).get() as Record<
    string,
    unknown
  > | null;
  assert.ok(row);
  const value = Object.values(row)[0];
  assert.equal(typeof value, 'number');
  return value;
}

function pragmaString(database: Database, name: string): string {
  const row = database.query(`PRAGMA ${name}`).get() as Record<
    string,
    unknown
  > | null;
  assert.ok(row);
  const value = Object.values(row)[0];
  assert.equal(typeof value, 'string');
  return value;
}

for (const [role, timeout] of [
  ['business-read-write', 250],
  ['migration-bootstrap', 1_000],
] as const) {
  test(`configureSqliteConnection applies and verifies the ${role} policy`, async () => {
    await withDatabasePath((databasePath) => {
      const database = new Database(databasePath, { create: true });
      try {
        const configuration = configureSqliteConnection(database, role);
        assert.deepEqual(configuration, {
          role,
          busyTimeoutMs: timeout,
          journalMode: 'wal',
          foreignKeys: true,
          synchronous: 'full',
          tempStore: 'memory',
          trustedSchema: false,
          queryOnly: false,
        });
        assert.equal(pragmaNumber(database, 'busy_timeout'), timeout);
        assert.equal(pragmaNumber(database, 'foreign_keys'), 1);
        assert.equal(pragmaString(database, 'journal_mode'), 'wal');
        assert.equal(pragmaNumber(database, 'synchronous'), 2);
        assert.equal(pragmaNumber(database, 'temp_store'), 2);
        assert.equal(pragmaNumber(database, 'trusted_schema'), 0);
        assert.equal(pragmaNumber(database, 'query_only'), 0);
      } finally {
        database.close();
      }
    });
  });
}

test('readonly policy observes WAL, enables query_only, and remains physically readonly', async () => {
  await withDatabasePath((databasePath) => {
    const creator = new Database(databasePath, { create: true });
    configureSqliteConnection(creator, 'business-read-write');
    creator.exec('CREATE TABLE item (value TEXT NOT NULL)');
    creator.close();

    const database = new Database(databasePath, {
      readonly: true,
      create: false,
    });
    try {
      configureSqliteConnection(database, 'business-read-only');
      assert.equal(pragmaNumber(database, 'busy_timeout'), 250);
      assert.equal(pragmaNumber(database, 'foreign_keys'), 1);
      assert.equal(pragmaString(database, 'journal_mode'), 'wal');
      assert.equal(pragmaNumber(database, 'synchronous'), 2);
      assert.equal(pragmaNumber(database, 'temp_store'), 2);
      assert.equal(pragmaNumber(database, 'trusted_schema'), 0);
      assert.equal(pragmaNumber(database, 'query_only'), 1);

      database.exec('PRAGMA query_only = OFF');
      assert.throws(
        () => database.query('INSERT INTO item VALUES (?)').run('blocked'),
        /readonly/i,
      );
    } finally {
      database.close();
    }
  });
});

test('readonly policy rejects a non-WAL database with a stable error', async () => {
  await withDatabasePath((databasePath) => {
    const creator = new Database(databasePath, { create: true });
    creator.exec('CREATE TABLE item (value TEXT)');
    creator.close();
    const database = new Database(databasePath, {
      readonly: true,
      create: false,
    });
    try {
      assert.throws(
        () => configureSqliteConnection(database, 'business-read-only'),
        (error) =>
          error instanceof SqliteConfigurationError &&
          error.code === 'wal_unavailable' &&
          error.pragma === 'journal_mode',
      );
    } finally {
      database.close();
    }
  });
});

type PragmaTestConnection = Parameters<typeof configureSqliteConnection>[0];

function injectedConnection(
  get: (sql: string) => Record<string, unknown> | null,
): PragmaTestConnection {
  return {
    query: (sql: string) => ({
      get: () => get(sql),
      run: () => undefined,
    }),
  } as PragmaTestConnection;
}

test('WAL setting validates both statement result and independent readback', () => {
  const expected = new Map<string, Record<string, unknown>>([
    ['PRAGMA busy_timeout = 250', { timeout: 250 }],
    ['PRAGMA busy_timeout', { timeout: 250 }],
    ['PRAGMA foreign_keys = ON', { foreign_keys: 1 }],
    ['PRAGMA foreign_keys', { foreign_keys: 1 }],
    ['PRAGMA journal_mode = WAL', { journal_mode: 'delete' }],
  ]);
  assert.throws(
    () =>
      configureSqliteConnection(
        injectedConnection((sql) => expected.get(sql) ?? null),
        'business-read-write',
      ),
    (error) =>
      error instanceof SqliteConfigurationError &&
      error.code === 'wal_unavailable' &&
      error.actual === 'delete',
  );
});

test('missing PRAGMA rows fail closed and sensitive actual values are redacted', () => {
  const secret = '/Users/private/database.sqlite?token=top-secret';
  const database = injectedConnection((sql) => {
    if (sql === 'PRAGMA busy_timeout = 250') return { timeout: 250 };
    if (sql === 'PRAGMA busy_timeout') return { timeout: secret };
    return null;
  });
  assert.throws(
    () => configureSqliteConnection(database, 'business-read-write'),
    (error) => {
      assert.ok(error instanceof SqliteConfigurationError);
      assert.equal(error.code, 'pragma_mismatch');
      assert.equal(error.actual, '[redacted]');
      const serialized = JSON.stringify(error);
      assert.doesNotMatch(
        `${error.message}${serialized}`,
        /private|top-secret/,
      );
      return true;
    },
  );

  const noRow = injectedConnection(() => null);
  assert.throws(
    () => configureSqliteConnection(noRow, 'business-read-write'),
    (error) =>
      error instanceof SqliteConfigurationError &&
      error.code === 'pragma_failed',
  );
});

test('configuration rejects unknown connection roles before executing a PRAGMA', () => {
  let queries = 0;
  const database = {
    query: () => {
      queries += 1;
      throw new Error('must not execute');
    },
  } as Parameters<typeof configureSqliteConnection>[0];
  assert.throws(
    () =>
      configureSqliteConnection(
        database,
        'unexpected-role' as SqliteConnectionRole,
      ),
    (error) =>
      error instanceof SqliteConfigurationError &&
      error.code === 'unsupported_runtime',
  );
  assert.equal(queries, 0);
});

test('diagnostics are sorted, deeply immutable, and reflect runtime capabilities', async () => {
  await withDatabasePath((databasePath) => {
    const database = new Database(databasePath, { create: true });
    try {
      const configuration = configureSqliteConnection(
        database,
        'business-read-write',
      );
      const diagnostics = createSqliteDiagnostics(database, configuration);
      assert.match(diagnostics.sqliteVersion, /^\d+\.\d+\.\d+/);
      assert.equal(diagnostics.connectionRole, 'business-read-write');
      assert.equal(diagnostics.journalMode, 'wal');
      assert.equal(diagnostics.foreignKeys, true);
      assert.equal(diagnostics.backupMethod, 'vacuum-into');
      assert.equal(diagnostics.returningSupport, true);
      assert.deepEqual(
        diagnostics.compileOptions,
        [...diagnostics.compileOptions].sort(),
      );
      assert.equal(Object.isFrozen(diagnostics), true);
      assert.equal(Object.isFrozen(diagnostics.compileOptions), true);
    } finally {
      database.close();
    }
  });
});

test('diagnostics reject unsafe compile options without leaking sensitive rows', () => {
  const secret = '/private/db.sqlite?credential=secret';
  const rows = new Map<string, Record<string, unknown>[]>([
    ['SELECT sqlite_version() AS sqliteVersion', [{ sqliteVersion: '3.54.0' }]],
    ['PRAGMA compile_options', [{ compile_options: 'OMIT_TRIGGER' }]],
  ]);
  const database = {
    query: (sql: string) => ({
      get: () => rows.get(sql)?.[0] ?? null,
      all: () => rows.get(sql) ?? [{ compile_options: secret }],
    }),
  } as Parameters<typeof createSqliteDiagnostics>[0];
  const configuration = Object.freeze({
    role: 'business-read-write' as SqliteConnectionRole,
    busyTimeoutMs: 250,
    journalMode: 'wal' as const,
    foreignKeys: true as const,
    synchronous: 'full' as const,
    tempStore: 'memory' as const,
    trustedSchema: false as const,
    queryOnly: false,
  });
  assert.throws(
    () => createSqliteDiagnostics(database, configuration),
    (error) => {
      assert.ok(error instanceof SqliteConfigurationError);
      assert.equal(error.code, 'unsupported_runtime');
      assert.doesNotMatch(
        `${error.message}${JSON.stringify(error)}`,
        /private|secret/,
      );
      return true;
    },
  );
});

test('diagnostics expose compile option names but never option values', () => {
  const database = {
    query: (sql: string) => ({
      get: () =>
        sql.startsWith('SELECT') ? { sqliteVersion: '3.54.0' } : null,
      all: () => [{ compile_options: 'SECRET_TOKEN=top-secret' }],
    }),
  } as Parameters<typeof createSqliteDiagnostics>[0];
  const configuration = Object.freeze({
    role: 'business-read-write' as const,
    busyTimeoutMs: 250 as const,
    journalMode: 'wal' as const,
    foreignKeys: true as const,
    synchronous: 'full' as const,
    tempStore: 'memory' as const,
    trustedSchema: false as const,
    queryOnly: false,
  });
  const diagnostics = createSqliteDiagnostics(database, configuration);
  assert.deepEqual(diagnostics.compileOptions, ['SECRET_TOKEN']);
  assert.doesNotMatch(JSON.stringify(diagnostics), /top-secret/);
});

test('diagnostics reject a version row with trailing sensitive text', () => {
  const database = {
    query: (sql: string) => ({
      get: () =>
        sql.startsWith('SELECT')
          ? { sqliteVersion: '3.54.0/private/database.sqlite' }
          : null,
      all: () => [{ compile_options: 'THREADSAFE=2' }],
    }),
  } as Parameters<typeof createSqliteDiagnostics>[0];
  const configuration = Object.freeze({
    role: 'business-read-write' as const,
    busyTimeoutMs: 250 as const,
    journalMode: 'wal' as const,
    foreignKeys: true as const,
    synchronous: 'full' as const,
    tempStore: 'memory' as const,
    trustedSchema: false as const,
    queryOnly: false,
  });
  assert.throws(
    () => createSqliteDiagnostics(database, configuration),
    (error) => {
      assert.ok(error instanceof SqliteConfigurationError);
      assert.doesNotMatch(
        `${error.message}${JSON.stringify(error)}`,
        /private|database\.sqlite/,
      );
      return true;
    },
  );
});

test('PASSIVE checkpoint reports incomplete with busy=0 while a reader pins WAL frames', async () => {
  await withDatabasePath((databasePath) => {
    const writer = new Database(databasePath, { create: true });
    let reader: Database | undefined;
    try {
      configureSqliteConnection(writer, 'business-read-write');
      writer.exec(
        'PRAGMA wal_autocheckpoint = 0; CREATE TABLE item (value TEXT)',
      );
      writer.query('INSERT INTO item VALUES (?)').run('before-reader');
      checkpointWal(writer);

      reader = new Database(databasePath, { readonly: true, create: false });
      configureSqliteConnection(reader, 'business-read-only');
      reader.exec('BEGIN');
      reader.query('SELECT * FROM item').all();
      writer.query('INSERT INTO item VALUES (?)').run('after-reader');

      const incomplete = checkpointWal(writer);
      assert.equal(incomplete.status, 'incomplete');
      assert.equal(incomplete.sqliteBusy, false);
      assert.ok(incomplete.logFrames > incomplete.checkpointedFrames);
      assert.equal(
        incomplete.remainingFrames,
        incomplete.logFrames - incomplete.checkpointedFrames,
      );

      reader.exec('ROLLBACK');
      reader.close();
      reader = undefined;
      const completed = checkpointWal(writer);
      assert.deepEqual(completed, {
        status: 'completed',
        sqliteBusy: false,
        logFrames: completed.logFrames,
        checkpointedFrames: completed.logFrames,
        remainingFrames: 0,
      });
    } finally {
      if (reader !== undefined) {
        try {
          reader.exec('ROLLBACK');
        } catch {
          // The transaction may not have started if setup failed.
        }
        reader.close();
      }
      writer.close();
    }
  });
});

test('checkpoint supports a narrow preflight interruption and validates SQLite rows', () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  const database = {
    query: () => ({
      get: () => {
        calls += 1;
        return { busy: 0, log: 0, checkpointed: 0 };
      },
    }),
  } as Parameters<typeof checkpointWal>[0];
  assert.deepEqual(checkpointWal(database, controller.signal), {
    status: 'interrupted',
    sqliteBusy: false,
    logFrames: 0,
    checkpointedFrames: 0,
    remainingFrames: 0,
  });
  assert.equal(calls, 0);

  const emptyWal = {
    query: () => ({ get: () => ({ busy: 0, log: -1, checkpointed: -1 }) }),
  } as Parameters<typeof checkpointWal>[0];
  assert.deepEqual(checkpointWal(emptyWal), {
    status: 'completed',
    sqliteBusy: false,
    logFrames: 0,
    checkpointedFrames: 0,
    remainingFrames: 0,
  });

  const invalid = {
    query: () => ({ get: () => ({ busy: 2, log: -1, checkpointed: 4 }) }),
  } as Parameters<typeof checkpointWal>[0];
  assert.throws(
    () => checkpointWal(invalid),
    (error) =>
      error instanceof WalCheckpointError &&
      error.code === 'invalid_checkpoint_result',
  );
});

test('checkpoint invokes PASSIVE exactly once and sanitizes SQLite failures', () => {
  let calls = 0;
  const database = {
    query: (sql: string) => {
      calls += 1;
      assert.equal(sql, 'PRAGMA wal_checkpoint(PASSIVE)');
      throw new Error('/private/database.sqlite?token=secret');
    },
  } as Parameters<typeof checkpointWal>[0];
  assert.throws(
    () => checkpointWal(database),
    (error) => {
      assert.ok(error instanceof WalCheckpointError);
      assert.equal(error.code, 'checkpoint_failed');
      assert.doesNotMatch(
        `${error.message}${JSON.stringify(error)}`,
        /private|secret/,
      );
      return true;
    },
  );
  assert.equal(calls, 1);
});
