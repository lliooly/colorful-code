import { createHash } from 'node:crypto';
import type { Database } from 'bun:sqlite';

export interface MigrationDatabase {
  exec(sql: string): void;
}

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly source: string;
  readonly up: (database: MigrationDatabase) => unknown;
}

export type MigrationErrorCode =
  | 'invalid_registry'
  | 'database_newer_than_program'
  | 'unknown_applied_migration'
  | 'checksum_mismatch'
  | 'migration_metadata_invalid'
  | 'migration_failed';

export class MigrationError extends Error {
  readonly code: MigrationErrorCode;
  readonly version?: number;
  readonly migrationName?: string;

  constructor(
    code: MigrationErrorCode,
    message: string,
    options: { version?: number; migrationName?: string; cause?: unknown } = {},
  ) {
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = 'MigrationError';
    this.code = code;
    this.version = options.version;
    this.migrationName = options.migrationName;
  }
}

function encodeField(value: string): string {
  return `${Buffer.byteLength(value, 'utf8')}:${value}`;
}

export function migrationChecksum(
  migration: Pick<Migration, 'version' | 'name' | 'source'>,
): string {
  const canonical = [
    encodeField(String(migration.version)),
    encodeField(migration.name),
    encodeField(migration.source),
  ].join('|');
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

function captureMigrationRegistry(
  registry: readonly Migration[],
): readonly Migration[] {
  const entries = [...registry];
  return Object.freeze(
    entries.map((migration) => {
      try {
        const version = migration.version;
        const name = migration.name;
        const source = migration.source;
        const up = migration.up;
        return Object.freeze({ version, name, source, up });
      } catch (cause) {
        throw new MigrationError(
          'invalid_registry',
          'Could not read migration descriptor',
          { cause },
        );
      }
    }),
  );
}

function validateCapturedRegistry(registry: readonly Migration[]): void {
  const names = new Set<string>();
  let previousVersion = 0;

  for (const migration of registry) {
    if (!Number.isSafeInteger(migration.version) || migration.version <= 0) {
      throw new MigrationError(
        'invalid_registry',
        'Migration versions must be positive safe integers',
        {
          version: migration.version,
          migrationName: migration.name,
        },
      );
    }
    if (migration.version <= previousVersion) {
      throw new MigrationError(
        'invalid_registry',
        'Migration versions must be strictly increasing',
        {
          version: migration.version,
          migrationName: migration.name,
        },
      );
    }
    if (
      typeof migration.name !== 'string' ||
      migration.name.trim().length === 0
    ) {
      throw new MigrationError(
        'invalid_registry',
        'Migration names must be non-empty',
        {
          version: migration.version,
        },
      );
    }
    if (names.has(migration.name)) {
      throw new MigrationError(
        'invalid_registry',
        'Migration names must be globally unique',
        {
          version: migration.version,
          migrationName: migration.name,
        },
      );
    }
    if (typeof migration.source !== 'string' || migration.source.length === 0) {
      throw new MigrationError(
        'invalid_registry',
        'Migration source must be non-empty',
        {
          version: migration.version,
          migrationName: migration.name,
        },
      );
    }
    if (typeof migration.up !== 'function') {
      throw new MigrationError(
        'invalid_registry',
        'Migration up must be a function',
        {
          version: migration.version,
          migrationName: migration.name,
        },
      );
    }

    previousVersion = migration.version;
    names.add(migration.name);
  }
}

export function validateMigrationRegistry(
  registry: readonly Migration[],
): void {
  validateCapturedRegistry(captureMigrationRegistry(registry));
}

export interface RunMigrationsOptions {
  now?: () => number;
  monotonicNow?: () => number;
}

type AppliedMigration = {
  version: unknown;
  name: unknown;
  checksum: unknown;
  applied_at: unknown;
  duration_ms: unknown;
};

type ValidAppliedMigration = {
  version: number;
  name: string;
  checksum: string;
  applied_at: number;
  duration_ms: number;
};

type MigrationDescriptor = Readonly<Migration & { checksum: string }>;

function snapshotRegistry(
  registry: readonly Migration[],
): readonly MigrationDescriptor[] {
  const captured = captureMigrationRegistry(registry);
  validateCapturedRegistry(captured);
  return Object.freeze(
    captured.map((migration) =>
      Object.freeze({
        version: migration.version,
        name: migration.name,
        source: migration.source,
        up: migration.up,
        checksum: migrationChecksum(migration),
      }),
    ),
  );
}

function requireFiniteTime(value: number, label: string): number {
  if (!Number.isFinite(value)) {
    throw new RangeError(`${label} must return a finite number`);
  }
  return value;
}

function requireNonNegativeSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`);
  }
  return value;
}

type ThenFunction = (
  this: unknown,
  onFulfilled: (value: unknown) => void,
  onRejected: (reason: unknown) => void,
) => unknown;

function getThen(value: unknown): ThenFunction | undefined {
  if (
    !(
      (typeof value === 'object' && value !== null) ||
      typeof value === 'function'
    )
  ) {
    return undefined;
  }
  const then = (value as { then?: unknown }).then;
  return typeof then === 'function' ? (then as ThenFunction) : undefined;
}

function observeThenable(value: unknown, then: ThenFunction): void {
  const observed = new Promise<unknown>((resolve, reject) => {
    try {
      then.call(value, resolve, reject);
    } catch (error) {
      reject(error);
    }
  });
  void observed.catch(() => undefined);
}

function skipSqlTrivia(sql: string, start = 0): number {
  let index = start;
  while (index < sql.length) {
    if (/\s/u.test(sql[index]!)) {
      index += 1;
      continue;
    }
    if (sql.startsWith('--', index)) {
      const newline = sql.indexOf('\n', index + 2);
      index = newline === -1 ? sql.length : newline + 1;
      continue;
    }
    if (sql.startsWith('/*', index)) {
      const close = sql.indexOf('*/', index + 2);
      index = close === -1 ? sql.length : close + 2;
      continue;
    }
    break;
  }
  return index;
}

const TRANSACTION_CONTROL_KEYWORDS = new Set([
  'BEGIN',
  'COMMIT',
  'END',
  'ROLLBACK',
  'SAVEPOINT',
  'RELEASE',
]);

function executeMigrationStatement(database: Database, sql: string): void {
  const statement = database.prepare(sql);
  try {
    const preparedSql = statement.toString();
    const tail = sql.slice(preparedSql.length);
    if (skipSqlTrivia(tail) !== tail.length) {
      throw new TypeError(
        'Migration database exec accepts exactly one SQL statement',
      );
    }

    const tokenStart = skipSqlTrivia(preparedSql);
    const firstToken = /^[A-Za-z]+/u
      .exec(preparedSql.slice(tokenStart))?.[0]
      ?.toUpperCase();
    if (
      firstToken !== undefined &&
      TRANSACTION_CONTROL_KEYWORDS.has(firstToken)
    ) {
      throw new TypeError(
        'Migration database exec cannot control transactions',
      );
    }

    statement.run();
  } finally {
    statement.finalize();
  }
}

const CREATE_SCHEMA_MIGRATIONS = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    checksum TEXT NOT NULL,
    applied_at INTEGER NOT NULL,
    duration_ms INTEGER NOT NULL
  ) STRICT;
`;

function metadataInvalid(message: string, cause?: unknown): MigrationError {
  return new MigrationError('migration_metadata_invalid', message, {
    ...(cause === undefined ? {} : { cause }),
  });
}

function validateMetadataSchema(database: Database): void {
  try {
    const table = database
      .query<
        {
          schema: string;
          name: string;
          type: string;
          ncol: number;
          strict: number;
        },
        []
      >('PRAGMA table_list')
      .all()
      .find((row) => row.schema === 'main' && row.name === 'schema_migrations');
    if (table?.type !== 'table' || table.ncol !== 5 || table.strict !== 1) {
      throw metadataInvalid('schema_migrations table identity is invalid');
    }

    const columns = database
      .query<
        {
          cid: number;
          name: string;
          type: string;
          notnull: number;
          pk: number;
        },
        []
      >('PRAGMA table_info(schema_migrations)')
      .all()
      .map(({ cid, name, type, notnull, pk }) => ({
        cid,
        name,
        type,
        notnull,
        pk,
      }));
    const expectedColumns = [
      { cid: 0, name: 'version', type: 'INTEGER', notnull: 0, pk: 1 },
      { cid: 1, name: 'name', type: 'TEXT', notnull: 1, pk: 0 },
      { cid: 2, name: 'checksum', type: 'TEXT', notnull: 1, pk: 0 },
      { cid: 3, name: 'applied_at', type: 'INTEGER', notnull: 1, pk: 0 },
      { cid: 4, name: 'duration_ms', type: 'INTEGER', notnull: 1, pk: 0 },
    ];
    if (JSON.stringify(columns) !== JSON.stringify(expectedColumns)) {
      throw metadataInvalid('schema_migrations columns are invalid');
    }

    const indexes = database
      .query<
        { name: string; unique: number; partial: number },
        []
      >('PRAGMA index_list(schema_migrations)')
      .all();
    const hasUniqueName = indexes.some((index) => {
      if (index.unique !== 1 || index.partial !== 0) return false;
      const indexedColumns = database
        .query<
          { name: string },
          [string]
        >('SELECT name FROM pragma_index_info(?) ORDER BY seqno')
        .all(index.name);
      return indexedColumns.length === 1 && indexedColumns[0]!.name === 'name';
    });
    if (!hasUniqueName) {
      throw metadataInvalid('schema_migrations name uniqueness is invalid');
    }
  } catch (cause) {
    if (
      cause instanceof MigrationError &&
      cause.code === 'migration_metadata_invalid'
    ) {
      throw cause;
    }
    throw metadataInvalid('Could not validate schema_migrations table', cause);
  }
}

function validateAppliedRows(
  rows: readonly AppliedMigration[],
): ValidAppliedMigration[] {
  return rows.map((row) => {
    const valid =
      Number.isSafeInteger(row.version) &&
      (row.version as number) > 0 &&
      typeof row.name === 'string' &&
      row.name.length > 0 &&
      typeof row.checksum === 'string' &&
      /^[0-9a-f]{64}$/u.test(row.checksum) &&
      Number.isSafeInteger(row.applied_at) &&
      (row.applied_at as number) >= 0 &&
      Number.isSafeInteger(row.duration_ms) &&
      (row.duration_ms as number) >= 0;
    if (!valid) {
      throw new MigrationError(
        'migration_metadata_invalid',
        'Applied migration metadata row is invalid',
        {
          ...(Number.isSafeInteger(row.version) && (row.version as number) > 0
            ? { version: row.version as number }
            : {}),
          ...(typeof row.name === 'string' && row.name.length > 0
            ? { migrationName: row.name }
            : {}),
        },
      );
    }
    return row as ValidAppliedMigration;
  });
}

export function runMigrations(
  database: Database,
  registry: readonly Migration[],
  options: RunMigrationsOptions = {},
): void {
  const descriptors = snapshotRegistry(registry);
  try {
    database.exec(CREATE_SCHEMA_MIGRATIONS);
  } catch (cause) {
    throw metadataInvalid('Could not ensure schema_migrations table', cause);
  }
  validateMetadataSchema(database);

  let applied: ValidAppliedMigration[];
  try {
    applied = validateAppliedRows(
      database
        .query<AppliedMigration, []>(
          `SELECT version, name, checksum, applied_at, duration_ms
           FROM schema_migrations ORDER BY version`,
        )
        .all(),
    );
  } catch (cause) {
    if (
      cause instanceof MigrationError &&
      cause.code === 'migration_metadata_invalid'
    ) {
      throw cause;
    }
    throw metadataInvalid('Could not read schema_migrations history', cause);
  }
  const programMaxVersion = descriptors.at(-1)?.version ?? 0;
  const databaseMaxVersion = applied.at(-1)?.version ?? 0;
  if (databaseMaxVersion > programMaxVersion) {
    const newest = applied.at(-1)!;
    throw new MigrationError(
      'database_newer_than_program',
      `Database migration version ${databaseMaxVersion} is newer than program version ${programMaxVersion}`,
      { version: databaseMaxVersion, migrationName: newest.name },
    );
  }

  for (const [index, stored] of applied.entries()) {
    const expected = descriptors[index];
    if (
      expected === undefined ||
      expected.version !== stored.version ||
      expected.name !== stored.name
    ) {
      throw new MigrationError(
        'unknown_applied_migration',
        `Applied migration ${stored.version}/${stored.name} is not in the program registry`,
        { version: stored.version, migrationName: stored.name },
      );
    }
    if (expected.checksum !== stored.checksum) {
      throw new MigrationError(
        'checksum_mismatch',
        `Applied migration ${stored.version}/${stored.name} checksum does not match`,
        { version: stored.version, migrationName: stored.name },
      );
    }
  }

  const appliedVersions = new Set(
    applied.map((migration) => migration.version),
  );
  const now = options.now ?? Date.now;
  const monotonicNow =
    options.monotonicNow ?? performance.now.bind(performance);

  for (const migration of descriptors) {
    if (appliedVersions.has(migration.version)) continue;

    let active = true;
    const facade: MigrationDatabase = Object.freeze({
      exec(sql: string): void {
        if (!active) {
          throw new TypeError('Migration database facade is no longer active');
        }
        executeMigrationStatement(database, sql);
      },
    });

    try {
      database
        .transaction(() => {
          const startedAt = requireFiniteTime(monotonicNow(), 'monotonicNow');
          let result: unknown;
          try {
            result = migration.up(facade);
          } finally {
            active = false;
          }
          const then = getThen(result);
          if (then !== undefined) {
            observeThenable(result, then);
            throw new TypeError(
              'Migration up must be synchronous and must not return a Promise',
            );
          }
          const endedAt = requireFiniteTime(monotonicNow(), 'monotonicNow');
          const duration = requireNonNegativeSafeInteger(
            Math.max(0, Math.floor(endedAt - startedAt)),
            'duration_ms',
          );
          const appliedAt = requireNonNegativeSafeInteger(
            Math.floor(requireFiniteTime(now(), 'now')),
            'applied_at',
          );
          database
            .query(
              `INSERT INTO schema_migrations
                 (version, name, checksum, applied_at, duration_ms)
               VALUES (?, ?, ?, ?, ?)`,
            )
            .run(
              migration.version,
              migration.name,
              migration.checksum,
              appliedAt,
              duration,
            );
        })
        .immediate();
    } catch (cause) {
      throw new MigrationError(
        'migration_failed',
        `Migration ${migration.version}/${migration.name} failed`,
        { version: migration.version, migrationName: migration.name, cause },
      );
    }
  }
}
