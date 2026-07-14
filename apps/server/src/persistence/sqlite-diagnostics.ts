import type { Database } from 'bun:sqlite';
import {
  SqliteConfigurationError,
  type SqliteConnectionConfiguration,
  type SqliteConnectionRole,
} from './sqlite-configuration';

export type SqliteDiagnostics = Readonly<{
  sqliteVersion: string;
  connectionRole: SqliteConnectionRole;
  journalMode: 'wal';
  foreignKeys: true;
  backupMethod: 'online-backup' | 'vacuum-into';
  returningSupport: boolean;
  compileOptions: readonly string[];
}>;

type DiagnosticConnection = Pick<Database, 'query'>;

const SAFE_COMPILE_OPTION = /^[A-Z][A-Z0-9_]*(?:=[A-Za-z0-9.,+_-]+)?$/;

function unsupported(role: SqliteConnectionRole, pragma?: string): never {
  throw new SqliteConfigurationError({
    code: 'unsupported_runtime',
    role,
    pragma,
  });
}

function parseVersion(
  version: unknown,
  role: SqliteConnectionRole,
): readonly [number, number, number] {
  if (typeof version !== 'string') unsupported(role);
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (match === null) unsupported(role);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function versionAtLeast(
  version: readonly [number, number, number],
  expected: readonly [number, number, number],
): boolean {
  for (let index = 0; index < 3; index += 1) {
    if (version[index] > expected[index]) return true;
    if (version[index] < expected[index]) return false;
  }
  return true;
}

function hasOnlineBackup(database: DiagnosticConnection): boolean {
  const candidate = database as object as Record<string, unknown>;
  return typeof candidate.backup === 'function';
}

function readDiagnosticPragma(
  database: DiagnosticConnection,
  role: SqliteConnectionRole,
  pragma: 'journal_mode' | 'foreign_keys',
): unknown {
  let row: Record<string, unknown> | null;
  try {
    row = database.query<Record<string, unknown>, []>(`PRAGMA ${pragma}`).get();
  } catch {
    throw new SqliteConfigurationError({
      code: 'pragma_failed',
      role,
      pragma,
    });
  }
  if (
    row === null ||
    Object.keys(row).length !== 1 ||
    !Object.prototype.propertyIsEnumerable.call(row, pragma)
  ) {
    throw new SqliteConfigurationError({
      code: 'pragma_failed',
      role,
      pragma,
    });
  }
  return row[pragma];
}

function verifyDiagnosticPragmas(
  database: DiagnosticConnection,
  role: SqliteConnectionRole,
): void {
  const journalMode = readDiagnosticPragma(database, role, 'journal_mode');
  if (typeof journalMode !== 'string' || journalMode.toLowerCase() !== 'wal') {
    throw new SqliteConfigurationError({
      code: 'pragma_mismatch',
      role,
      pragma: 'journal_mode',
      expected: 'wal',
      actual: journalMode,
    });
  }
  const foreignKeys = readDiagnosticPragma(database, role, 'foreign_keys');
  if (foreignKeys !== 1) {
    throw new SqliteConfigurationError({
      code: 'pragma_mismatch',
      role,
      pragma: 'foreign_keys',
      expected: 1,
      actual: foreignKeys,
    });
  }
}

export function createSqliteDiagnostics(
  database: DiagnosticConnection,
  configuration: SqliteConnectionConfiguration,
): SqliteDiagnostics {
  const role = configuration.role;
  verifyDiagnosticPragmas(database, role);
  let versionRow: { sqliteVersion: unknown } | null;
  let compileRows: { compile_options: unknown }[];
  try {
    versionRow = database
      .query<
        { sqliteVersion: unknown },
        []
      >('SELECT sqlite_version() AS sqliteVersion')
      .get();
    compileRows = database
      .query<{ compile_options: unknown }, []>('PRAGMA compile_options')
      .all();
  } catch {
    unsupported(role);
  }
  if (versionRow === null) unsupported(role);
  const sqliteVersion = versionRow.sqliteVersion;
  const numericVersion = parseVersion(sqliteVersion, role);
  if (typeof sqliteVersion !== 'string') unsupported(role);

  const compileOptionsWithValues = compileRows.map(
    ({ compile_options: option }) => {
      if (typeof option !== 'string' || !SAFE_COMPILE_OPTION.test(option)) {
        unsupported(role, 'compile_options');
      }
      return option;
    },
  );
  const optionNames = new Set(
    compileOptionsWithValues.map((option) => option.split('=', 1)[0]),
  );
  if (optionNames.has('OMIT_FOREIGN_KEY') || optionNames.has('OMIT_TRIGGER')) {
    unsupported(role, 'compile_options');
  }

  let backupMethod: SqliteDiagnostics['backupMethod'];
  if (hasOnlineBackup(database)) {
    backupMethod = 'online-backup';
  } else if (versionAtLeast(numericVersion, [3, 27, 0])) {
    backupMethod = 'vacuum-into';
  } else {
    unsupported(role);
  }

  const frozenCompileOptions = Object.freeze([...optionNames].sort());
  return Object.freeze({
    sqliteVersion,
    connectionRole: role,
    journalMode: 'wal',
    foreignKeys: true,
    backupMethod,
    returningSupport: versionAtLeast(numericVersion, [3, 35, 0]),
    compileOptions: frozenCompileOptions,
  });
}
