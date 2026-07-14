import type { Database } from 'bun:sqlite';

export type SqliteConnectionRole =
  | 'business-read-write'
  | 'business-read-only'
  | 'migration-bootstrap';

export type SqliteConfigurationErrorCode =
  | 'pragma_failed'
  | 'pragma_mismatch'
  | 'wal_unavailable'
  | 'unsupported_runtime';

export type SqliteConnectionConfiguration = Readonly<{
  role: SqliteConnectionRole;
  busyTimeoutMs: 250 | 1_000;
  journalMode: 'wal';
  foreignKeys: true;
  synchronous: 'full';
  tempStore: 'memory';
  trustedSchema: false;
  queryOnly: boolean;
}>;

export type SqliteConfigurationConnection = Pick<Database, 'query'>;

type SafeErrorValue = string | number | boolean | null;

const SAFE_SQLITE_VALUES = new Set([
  'delete',
  'extra',
  'full',
  'memory',
  'normal',
  'off',
  'on',
  'persist',
  'truncate',
  'wal',
]);

function filterErrorValue(value: unknown): SafeErrorValue {
  if (
    value === null ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (typeof value === 'string') {
    const normalized = value.toLowerCase();
    return SAFE_SQLITE_VALUES.has(normalized) ? normalized : '[redacted]';
  }
  return '[redacted]';
}

export class SqliteConfigurationError extends Error {
  readonly code: SqliteConfigurationErrorCode;
  readonly role: SqliteConnectionRole | 'unknown';
  readonly pragma?: string;
  readonly expected?: SafeErrorValue;
  readonly actual?: SafeErrorValue;

  constructor(options: {
    code: SqliteConfigurationErrorCode;
    role: SqliteConnectionRole | 'unknown';
    pragma?: string;
    expected?: unknown;
    actual?: unknown;
  }) {
    super(
      `SQLite configuration rejected (${options.code}, role=${options.role}${
        options.pragma === undefined ? '' : `, pragma=${options.pragma}`
      })`,
    );
    this.name = 'SqliteConfigurationError';
    this.code = options.code;
    this.role = options.role;
    this.pragma = options.pragma;
    this.expected =
      options.expected === undefined
        ? undefined
        : filterErrorValue(options.expected);
    this.actual =
      options.actual === undefined
        ? undefined
        : filterErrorValue(options.actual);
  }
}

function readSingleValue(
  database: SqliteConfigurationConnection,
  role: SqliteConnectionRole,
  pragma: string,
  statement: string,
): unknown {
  let row: Record<string, unknown> | null;
  try {
    row = database.query<Record<string, unknown>, []>(statement).get();
  } catch {
    throw new SqliteConfigurationError({
      code: 'pragma_failed',
      role,
      pragma,
    });
  }
  if (row === null) {
    throw new SqliteConfigurationError({
      code: 'pragma_failed',
      role,
      pragma,
    });
  }
  const values = Object.values(row);
  if (values.length !== 1) {
    throw new SqliteConfigurationError({
      code: 'pragma_failed',
      role,
      pragma,
    });
  }
  return values[0];
}

function setPragma(
  database: SqliteConfigurationConnection,
  role: SqliteConnectionRole,
  pragma: string,
  statement: string,
): void {
  try {
    database.query(statement).run();
  } catch {
    throw new SqliteConfigurationError({
      code: 'pragma_failed',
      role,
      pragma,
    });
  }
}

function expectPragma(
  database: SqliteConfigurationConnection,
  role: SqliteConnectionRole,
  pragma: string,
  expected: string | number,
): void {
  const actual = readSingleValue(database, role, pragma, `PRAGMA ${pragma}`);
  const matches =
    typeof expected === 'string'
      ? typeof actual === 'string' &&
        actual.toLowerCase() === expected.toLowerCase()
      : actual === expected;
  if (!matches) {
    throw new SqliteConfigurationError({
      code: pragma === 'journal_mode' ? 'wal_unavailable' : 'pragma_mismatch',
      role,
      pragma,
      expected,
      actual,
    });
  }
}

function setAndVerify(
  database: SqliteConfigurationConnection,
  role: SqliteConnectionRole,
  pragma: string,
  setting: string | number,
  expected: string | number,
): void {
  setPragma(database, role, pragma, `PRAGMA ${pragma} = ${setting}`);
  expectPragma(database, role, pragma, expected);
}

export function configureSqliteConnection(
  database: SqliteConfigurationConnection,
  role: SqliteConnectionRole,
): SqliteConnectionConfiguration {
  if (
    role !== 'business-read-write' &&
    role !== 'business-read-only' &&
    role !== 'migration-bootstrap'
  ) {
    throw new SqliteConfigurationError({
      code: 'unsupported_runtime',
      role: 'unknown',
    });
  }
  const busyTimeoutMs = role === 'migration-bootstrap' ? 1_000 : 250;
  setAndVerify(database, role, 'busy_timeout', busyTimeoutMs, busyTimeoutMs);
  setAndVerify(database, role, 'foreign_keys', 'ON', 1);

  if (role === 'business-read-only') {
    expectPragma(database, role, 'journal_mode', 'wal');
  } else {
    const settingResult = readSingleValue(
      database,
      role,
      'journal_mode',
      'PRAGMA journal_mode = WAL',
    );
    if (
      typeof settingResult !== 'string' ||
      settingResult.toLowerCase() !== 'wal'
    ) {
      throw new SqliteConfigurationError({
        code: 'wal_unavailable',
        role,
        pragma: 'journal_mode',
        expected: 'wal',
        actual: settingResult,
      });
    }
    expectPragma(database, role, 'journal_mode', 'wal');
  }

  setAndVerify(database, role, 'synchronous', 'FULL', 2);
  setAndVerify(database, role, 'temp_store', 'MEMORY', 2);
  setAndVerify(database, role, 'trusted_schema', 'OFF', 0);
  const queryOnly = role === 'business-read-only';
  setAndVerify(
    database,
    role,
    'query_only',
    queryOnly ? 'ON' : 'OFF',
    queryOnly ? 1 : 0,
  );

  return Object.freeze({
    role,
    busyTimeoutMs,
    journalMode: 'wal',
    foreignKeys: true,
    synchronous: 'full',
    tempStore: 'memory',
    trustedSchema: false,
    queryOnly,
  });
}
