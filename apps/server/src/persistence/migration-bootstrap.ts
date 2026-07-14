import { mkdir } from 'node:fs/promises';
import { Database } from 'bun:sqlite';
import {
  createMigrationBackup,
  quarantineDatabase,
  restoreMigrationBackup,
  verifyDatabase,
  type MigrationBackup,
  type QuarantinedDatabase,
  type RestoreMigrationBackupOptions,
} from './migration-backup-recovery';
import { resolveDatabasePath } from './database-path';
import {
  runMigrations,
  validateMigrationRegistry,
  type Migration,
} from './migration-framework';

export const MIGRATIONS: readonly Migration[] = Object.freeze([]);

export interface MigrationBootstrapDatabase {
  close(force?: boolean): void | Promise<void>;
}

export type MigrationRecoveryErrorCode =
  | 'backup_failed'
  | 'migration_failed_recovered'
  | 'migration_failed_recovery_failed';

export class MigrationRecoveryError extends Error {
  readonly code: MigrationRecoveryErrorCode;
  readonly databasePath: string;
  readonly backup?: MigrationBackup;
  readonly quarantine?: QuarantinedDatabase;

  constructor(
    code: MigrationRecoveryErrorCode,
    databasePath: string,
    message: string,
    options: {
      cause: unknown;
      backup?: MigrationBackup;
      quarantine?: QuarantinedDatabase;
    },
  ) {
    super(message, { cause: options.cause });
    this.name = 'MigrationRecoveryError';
    this.code = code;
    this.databasePath = databasePath;
    this.backup = options.backup;
    this.quarantine = options.quarantine;
  }
}

export interface MigrationSchemaState {
  readonly initialized: boolean;
  readonly version: number;
}

export interface BootstrapMigrationOptions {
  migrations?: readonly Migration[];
  mkdir?: (
    path: string,
    options: { recursive: true },
  ) => void | Promise<unknown>;
  openDatabase?: (
    databasePath: string,
    options: { create: true; readwrite: true },
  ) => MigrationBootstrapDatabase;
  runMigrations?: (
    database: MigrationBootstrapDatabase,
    migrations: readonly Migration[],
  ) => unknown;
  inspectSchema?: (
    database: MigrationBootstrapDatabase,
  ) => MigrationSchemaState;
  createBackup?: (options: {
    database: MigrationBootstrapDatabase;
    sourceDatabasePath: string;
    sourceSchemaVersion: number;
    targetSchemaVersion: number;
  }) => MigrationBackup;
  verifyMigratedDatabase?: (databasePath: string) => void;
  quarantineFailedDatabase?: (options: {
    databasePath: string;
  }) => QuarantinedDatabase;
  restoreBackup?: (options: RestoreMigrationBackupOptions) => void;
}

function inspectMigrationSchema(database: Database): MigrationSchemaState {
  const table = database
    .query<
      { count: number },
      []
    >("SELECT count(*) AS count FROM sqlite_schema WHERE type = 'table' AND name = 'schema_migrations'")
    .get();
  if (table?.count !== 1) return { initialized: false, version: 0 };

  const row = database
    .query<
      { version: number | null },
      []
    >('SELECT max(version) AS version FROM schema_migrations')
    .get();
  const version = row?.version ?? 0;
  if (!Number.isSafeInteger(version) || version < 0) {
    throw new Error('Current migration schema version is invalid');
  }
  return { initialized: true, version };
}

function captureMigrationRegistry(
  registry: readonly Migration[],
): readonly Migration[] {
  return Object.freeze(
    [...registry].map((migration) =>
      Object.freeze({
        version: migration.version,
        name: migration.name,
        source: migration.source,
        up: migration.up,
      }),
    ),
  );
}

export async function bootstrapMigrations(
  databasePath: string,
  options: BootstrapMigrationOptions = {},
): Promise<void> {
  const resolvedPath = await resolveDatabasePath(databasePath);
  await (options.mkdir ?? mkdir)(resolvedPath.dataDirectory, {
    recursive: true,
  });

  const openDatabase =
    options.openDatabase ??
    ((path: string, databaseOptions: { create: true; readwrite: true }) =>
      new Database(path, databaseOptions));
  const migrate =
    options.runMigrations ??
    ((database: MigrationBootstrapDatabase, migrations: readonly Migration[]) =>
      runMigrations(database as Database, migrations));
  const inspect =
    options.inspectSchema ??
    ((database: MigrationBootstrapDatabase) =>
      inspectMigrationSchema(database as Database));
  const backupDatabase =
    options.createBackup ??
    ((backupOptions: {
      database: MigrationBootstrapDatabase;
      sourceDatabasePath: string;
      sourceSchemaVersion: number;
      targetSchemaVersion: number;
    }) =>
      createMigrationBackup({
        ...backupOptions,
        database: backupOptions.database as Database,
      }));
  const verifyMigrated = options.verifyMigratedDatabase ?? verifyDatabase;
  const quarantine = options.quarantineFailedDatabase ?? quarantineDatabase;
  const restore = options.restoreBackup ?? restoreMigrationBackup;
  const configuredMigrations = options.migrations ?? MIGRATIONS;
  const database = openDatabase(resolvedPath.databasePath, {
    create: true,
    readwrite: true,
  });

  let phase: 'preflight' | 'backup' | 'migration' = 'preflight';
  let backup: MigrationBackup | undefined;
  let failed = false;
  let failure: unknown;
  try {
    const migrations = captureMigrationRegistry(configuredMigrations);
    validateMigrationRegistry(migrations);
    const schema = inspect(database);
    const targetVersion = migrations.at(-1)?.version ?? 0;
    const needsBackup = !schema.initialized || schema.version < targetVersion;
    if (needsBackup) {
      phase = 'backup';
      backup = backupDatabase({
        database,
        sourceDatabasePath: resolvedPath.databasePath,
        sourceSchemaVersion: schema.version,
        targetSchemaVersion: targetVersion,
      });
    }

    phase = 'migration';
    await migrate(database, migrations);
    verifyMigrated(resolvedPath.databasePath);
  } catch (error) {
    failed = true;
    failure = error;
  }

  let closeError: unknown;
  let closeFailed = false;
  try {
    await database.close(true);
  } catch (error) {
    closeFailed = true;
    closeError = error;
  }

  if (!failed) {
    if (closeFailed) throw closeError;
    return;
  }

  if (phase === 'backup') {
    throw new MigrationRecoveryError(
      'backup_failed',
      resolvedPath.databasePath,
      'Migration backup failed before migrations started',
      {
        cause: closeFailed
          ? new AggregateError([failure, closeError])
          : failure,
      },
    );
  }

  // Registry/preflight failures and up-to-date validation failures occur before
  // any pending migration can mutate the database, so there is no backup to
  // restore and no failed database to quarantine.
  if (backup === undefined) {
    if (closeFailed) {
      throw new AggregateError(
        [failure, closeError],
        'Database migration validation and close failed',
      );
    }
    throw failure;
  }

  let quarantined: QuarantinedDatabase | undefined;
  try {
    quarantined = quarantine({ databasePath: resolvedPath.databasePath });
    restore({
      backup,
      targetDatabasePath: resolvedPath.databasePath,
      quarantine: quarantined,
    });
  } catch (recoveryError) {
    const errors = [failure];
    if (closeFailed) errors.push(closeError);
    errors.push(recoveryError);
    throw new MigrationRecoveryError(
      'migration_failed_recovery_failed',
      resolvedPath.databasePath,
      'Database migration failed and recovery did not complete',
      {
        cause: new AggregateError(errors),
        backup,
        ...(quarantined === undefined ? {} : { quarantine: quarantined }),
      },
    );
  }

  const errors = [failure];
  if (closeFailed) errors.push(closeError);
  throw new MigrationRecoveryError(
    'migration_failed_recovered',
    resolvedPath.databasePath,
    'Database migration failed; the pre-migration backup was restored',
    {
      cause: new AggregateError(errors),
      backup,
      quarantine: quarantined,
    },
  );
}
