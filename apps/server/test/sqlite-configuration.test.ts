import { strict as assert } from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Database } from 'bun:sqlite';
import {
  configureSqliteConnection,
  configureSqliteSnapshotConnection,
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
  if (typeof value !== 'number') throw new TypeError('Expected number PRAGMA');
  return value;
}

function pragmaString(database: Database, name: string): string {
  const row = database.query(`PRAGMA ${name}`).get() as Record<
    string,
    unknown
  > | null;
  assert.ok(row);
  const value = Object.values(row)[0];
  if (typeof value !== 'string') throw new TypeError('Expected string PRAGMA');
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
    try {
      configureSqliteConnection(creator, 'business-read-write');
      creator.exec('CREATE TABLE item (value TEXT NOT NULL)');
    } finally {
      creator.close();
    }

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
    try {
      creator.exec('CREATE TABLE item (value TEXT)');
    } finally {
      creator.close();
    }
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

test('snapshot policy securely accepts bounded WAL and rollback snapshots', async () => {
  await withDatabasePath((databasePath) => {
    const creator = new Database(databasePath, { create: true });
    creator.exec('CREATE TABLE item(value TEXT)');
    creator.close(true);

    const rollbackSnapshot = new Database(databasePath, { readonly: true });
    try {
      assert.equal(
        configureSqliteSnapshotConnection(rollbackSnapshot).journalMode,
        'delete',
      );
      assert.equal(pragmaNumber(rollbackSnapshot, 'foreign_keys'), 1);
      assert.equal(pragmaNumber(rollbackSnapshot, 'trusted_schema'), 0);
      assert.equal(pragmaNumber(rollbackSnapshot, 'query_only'), 1);
    } finally {
      rollbackSnapshot.close(true);
    }

    const writer = new Database(databasePath, { readwrite: true });
    writer.exec("PRAGMA journal_mode = WAL; INSERT INTO item VALUES ('wal')");
    const walSnapshot = new Database(databasePath, { readonly: true });
    try {
      assert.equal(
        configureSqliteSnapshotConnection(walSnapshot).journalMode,
        'wal',
      );
    } finally {
      walSnapshot.close(true);
      writer.close(true);
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
  } as unknown as PragmaTestConnection;
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

test('configuration executes each PRAGMA exactly once in the security policy order', () => {
  const calls: string[] = [];
  const rows = new Map<string, Record<string, unknown>>([
    ['PRAGMA busy_timeout', { timeout: 250 }],
    ['PRAGMA foreign_keys', { foreign_keys: 1 }],
    ['PRAGMA journal_mode = WAL', { journal_mode: 'wal' }],
    ['PRAGMA journal_mode', { journal_mode: 'wal' }],
    ['PRAGMA synchronous', { synchronous: 2 }],
    ['PRAGMA temp_store', { temp_store: 2 }],
    ['PRAGMA trusted_schema', { trusted_schema: 0 }],
    ['PRAGMA query_only', { query_only: 0 }],
  ]);
  const database = {
    query: (sql: string) => {
      calls.push(sql);
      return {
        get: () => rows.get(sql) ?? null,
        run: () => undefined,
      };
    },
  } as unknown as Parameters<typeof configureSqliteConnection>[0];

  configureSqliteConnection(database, 'business-read-write');

  assert.deepEqual(calls, [
    'PRAGMA busy_timeout = 250',
    'PRAGMA busy_timeout',
    'PRAGMA foreign_keys = ON',
    'PRAGMA foreign_keys',
    'PRAGMA journal_mode = WAL',
    'PRAGMA journal_mode',
    'PRAGMA synchronous = FULL',
    'PRAGMA synchronous',
    'PRAGMA temp_store = MEMORY',
    'PRAGMA temp_store',
    'PRAGMA trusted_schema = OFF',
    'PRAGMA trusted_schema',
    'PRAGMA query_only = OFF',
    'PRAGMA query_only',
  ]);
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
      assert.equal(diagnostics.busyTimeoutMs, 250);
      assert.equal(diagnostics.synchronous, 'full');
      assert.equal(diagnostics.tempStore, 'memory');
      assert.equal(diagnostics.trustedSchema, false);
      assert.equal(diagnostics.queryOnly, false);
      assert.equal(diagnostics.backupMethod, 'connection-serialize');
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
    ['PRAGMA journal_mode', [{ journal_mode: 'wal' }]],
    ['PRAGMA foreign_keys', [{ foreign_keys: 1 }]],
  ]);
  const database = {
    query: (sql: string) => ({
      get: () => rows.get(sql)?.[0] ?? null,
      all: () => rows.get(sql) ?? [{ compile_options: secret }],
    }),
  } as Parameters<typeof createSqliteDiagnostics>[0];
  const configuration = Object.freeze({
    role: 'business-read-write' as const,
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

function diagnosticAdapter(options: {
  version: string;
  compileOptions?: string[];
  serialize?: () => Uint8Array;
}): Parameters<typeof createSqliteDiagnostics>[0] {
  return {
    serialize: options.serialize ?? (() => new Uint8Array()),
    query: (sql: string) => ({
      get: () => {
        if (sql === 'PRAGMA journal_mode') return { journal_mode: 'wal' };
        if (sql === 'PRAGMA foreign_keys') return { foreign_keys: 1 };
        if (sql.startsWith('SELECT')) {
          return { sqliteVersion: options.version };
        }
        return null;
      },
      all: () =>
        (options.compileOptions ?? ['THREADSAFE=2']).map((compile_options) => ({
          compile_options,
        })),
    }),
  } as Parameters<typeof createSqliteDiagnostics>[0];
}

const diagnosticConfiguration = Object.freeze({
  role: 'business-read-write' as const,
  busyTimeoutMs: 250 as const,
  journalMode: 'wal' as const,
  foreignKeys: true as const,
  synchronous: 'full' as const,
  tempStore: 'memory' as const,
  trustedSchema: false as const,
  queryOnly: false,
});

test('diagnostics report the connection serialization backup capability', () => {
  const database = diagnosticAdapter({
    version: '3.54.0',
    serialize: () => new Uint8Array(),
  });
  assert.equal(
    createSqliteDiagnostics(database, diagnosticConfiguration).backupMethod,
    'connection-serialize',
  );
});

test('diagnostics require connection serialization without requiring VACUUM', () => {
  assert.equal(
    createSqliteDiagnostics(
      diagnosticAdapter({
        version: '3.54.0',
        compileOptions: ['OMIT_VACUUM'],
      }),
      diagnosticConfiguration,
    ).backupMethod,
    'connection-serialize',
  );
  assert.throws(
    () =>
      createSqliteDiagnostics(
        {
          ...diagnosticAdapter({ version: '3.54.0' }),
          serialize: undefined,
        } as unknown as Parameters<typeof createSqliteDiagnostics>[0],
        diagnosticConfiguration,
      ),
    (error) =>
      error instanceof SqliteConfigurationError &&
      error.code === 'unsupported_runtime',
  );
});

test('diagnostics reject forged or throwing roles without querying or leaking them', () => {
  const secret = '/private/database.sqlite?token=secret';
  let queries = 0;
  const database = {
    serialize: () => new Uint8Array(),
    query: () => {
      queries += 1;
      throw new Error('must not query');
    },
  } as unknown as Parameters<typeof createSqliteDiagnostics>[0];
  const configurations = [
    { ...diagnosticConfiguration, role: secret },
    Object.defineProperty({ ...diagnosticConfiguration }, 'role', {
      enumerable: true,
      get: () => {
        throw new Error(secret);
      },
    }),
  ];
  for (const configuration of configurations) {
    assert.throws(
      () =>
        createSqliteDiagnostics(
          database,
          configuration as typeof diagnosticConfiguration,
        ),
      (error) => {
        assert.ok(error instanceof SqliteConfigurationError);
        assert.equal(error.code, 'unsupported_runtime');
        assert.equal(error.role, 'unknown');
        assert.doesNotMatch(
          `${error.message}${JSON.stringify(error)}`,
          /private|token|secret/,
        );
        return true;
      },
    );
  }
  assert.equal(queries, 0);
});

for (const [pragma, actual] of [
  ['journal_mode', 'delete'],
  ['foreign_keys', 0],
] as const) {
  test(`diagnostics independently reject mismatched ${pragma}`, () => {
    const database = {
      query: (sql: string) => ({
        get: () => {
          if (sql.startsWith('SELECT')) return { sqliteVersion: '3.54.0' };
          if (sql === 'PRAGMA journal_mode') {
            return { journal_mode: pragma === 'journal_mode' ? actual : 'wal' };
          }
          if (sql === 'PRAGMA foreign_keys') {
            return { foreign_keys: pragma === 'foreign_keys' ? actual : 1 };
          }
          return null;
        },
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
        assert.equal(error.code, 'pragma_mismatch');
        assert.equal(error.pragma, pragma);
        return true;
      },
    );
  });
}

test('diagnostics expose compile option names but never option values', () => {
  const database = {
    serialize: () => new Uint8Array(),
    query: (sql: string) => ({
      get: () => {
        if (sql.startsWith('SELECT')) return { sqliteVersion: '3.54.0' };
        if (sql === 'PRAGMA journal_mode') return { journal_mode: 'wal' };
        if (sql === 'PRAGMA foreign_keys') return { foreign_keys: 1 };
        return null;
      },
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
      get: () => {
        if (sql.startsWith('SELECT')) {
          return { sqliteVersion: '3.54.0/private/database.sqlite' };
        }
        if (sql === 'PRAGMA journal_mode') return { journal_mode: 'wal' };
        if (sql === 'PRAGMA foreign_keys') return { foreign_keys: 1 };
        return null;
      },
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
    let reader: Database | undefined;
    const writer = new Database(databasePath, { create: true });
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

test('checkpoint supports a narrow preflight interruption', () => {
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
  } as unknown as Parameters<typeof checkpointWal>[0];
  assert.deepEqual(checkpointWal(database, controller.signal), {
    status: 'interrupted',
    sqliteBusy: false,
    logFrames: 0,
    checkpointedFrames: 0,
    remainingFrames: 0,
  });
  assert.equal(calls, 0);
});

test('checkpoint preserves SQLite busy separately from incomplete frames', () => {
  const database = {
    query: () => ({
      get: () => ({ busy: 1, log: 7, checkpointed: 3 }),
    }),
  } as unknown as Parameters<typeof checkpointWal>[0];
  assert.deepEqual(checkpointWal(database), {
    status: 'incomplete',
    sqliteBusy: true,
    logFrames: 7,
    checkpointedFrames: 3,
    remainingFrames: 4,
  });
});

test('checkpoint completes a real empty WAL', async () => {
  await withDatabasePath((databasePath) => {
    const wal = new Database(databasePath, { create: true });
    try {
      configureSqliteConnection(wal, 'business-read-write');
      assert.deepEqual(checkpointWal(wal), {
        status: 'completed',
        sqliteBusy: false,
        logFrames: 0,
        checkpointedFrames: 0,
        remainingFrames: 0,
      });
    } finally {
      wal.close();
    }
  });
});

for (const { name, row } of [
  {
    name: 'both frame counts at the SQLite -1 sentinel',
    row: { busy: 0, log: -1, checkpointed: -1 },
  },
  {
    name: 'only log at the SQLite -1 sentinel',
    row: { busy: 0, log: -1, checkpointed: 0 },
  },
  {
    name: 'only checkpointed at the SQLite -1 sentinel',
    row: { busy: 0, log: 0, checkpointed: -1 },
  },
  {
    name: 'unsafe busy',
    row: { busy: Number.MAX_SAFE_INTEGER + 1, log: 0, checkpointed: 0 },
  },
  {
    name: 'unsafe log',
    row: { busy: 0, log: Number.MAX_SAFE_INTEGER + 1, checkpointed: 0 },
  },
  {
    name: 'unsafe checkpointed',
    row: { busy: 0, log: 0, checkpointed: Number.MAX_SAFE_INTEGER + 1 },
  },
] as const) {
  test(`checkpoint rejects ${name}`, () => {
    const database = {
      query: () => ({ get: () => row }),
    } as unknown as Parameters<typeof checkpointWal>[0];
    assert.throws(
      () => checkpointWal(database),
      (error) =>
        error instanceof WalCheckpointError &&
        error.code === 'invalid_checkpoint_result',
    );
  });
}

test('checkpoint rejects a real non-WAL database', async () => {
  await withDatabasePath((databasePath) => {
    const database = new Database(databasePath, { create: true });
    try {
      assert.throws(
        () => checkpointWal(database),
        (error) =>
          error instanceof WalCheckpointError &&
          error.code === 'invalid_checkpoint_result',
      );
    } finally {
      database.close();
    }
  });
});

test('checkpoint rejects rows with missing or extra enumerable columns', () => {
  for (const row of [
    { busy: 0, log: 1 },
    { busy: 0, log: 1, checkpointed: 1, database: '/private/secret.db' },
  ]) {
    const database = {
      query: () => ({ get: () => row }),
    } as unknown as Parameters<typeof checkpointWal>[0];
    assert.throws(
      () => checkpointWal(database),
      (error) =>
        error instanceof WalCheckpointError &&
        error.code === 'invalid_checkpoint_result',
    );
  }
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
