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
  adoptUnmanagedMigration,
  migrationChecksum,
  MigrationError,
  runMigrations,
  validateMigrationRegistry,
  type Migration,
  type MigrationDatabase,
} from './migration-framework';
import {
  LEGACY_1X_SCHEMA_CHECKSUM,
  LEGACY_1X_SCHEMA_SOURCE,
  LEGACY_1X_SCHEMA_STATEMENTS,
  inspectLegacySchema,
  legacyDataChecksum,
  legacySchemaChecksum,
} from './legacy-schema-baseline';
import { configureSqliteConnection } from './sqlite-configuration';

export const LEGACY_1X_BASELINE_MIGRATION: Migration = Object.freeze({
  version: 1,
  name: 'legacy_1x_baseline',
  source: LEGACY_1X_SCHEMA_SOURCE,
  up(database: MigrationDatabase) {
    for (const statement of LEGACY_1X_SCHEMA_STATEMENTS) {
      database.exec(statement);
    }
  },
});

// Published with the 1.x baseline. Changing the migration source without
// appending a new migration makes module initialization fail closed.
export const LEGACY_1X_BASELINE_MIGRATION_CHECKSUM =
  'ddefa67f9e16f4b3f5ba28899b7955008c8dd6c4194023a67b11cf65245e5626';

if (
  migrationChecksum(LEGACY_1X_BASELINE_MIGRATION) !==
  LEGACY_1X_BASELINE_MIGRATION_CHECKSUM
) {
  throw new Error('Published 1.x baseline migration checksum drifted');
}

export const MIGRATIONS: readonly Migration[] = Object.freeze([
  LEGACY_1X_BASELINE_MIGRATION,
]);

export interface MigrationBootstrapDatabase {
  close(force?: boolean): void | Promise<void>;
}

export type MigrationRecoveryErrorCode =
  | 'backup_failed'
  | 'migration_failed_recovered'
  | 'migration_failed_recovery_failed';

export class MigrationRecoveryError extends Error {
  readonly code: MigrationRecoveryErrorCode;

  constructor(
    code: MigrationRecoveryErrorCode,
    _databasePath: string,
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
  }
}

export interface MigrationSchemaState {
  readonly initialized: boolean;
  readonly version: number;
  readonly unmanaged?: 'empty' | 'legacy-1x';
  readonly legacyDataChecksum?: string;
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

function inspectMigrationMetadata(database: Database): MigrationSchemaState {
  const tableStatement = database.prepare<{ count: number }, []>(
    "SELECT count(*) AS count FROM sqlite_schema WHERE type = 'table' AND name = 'schema_migrations'",
  );
  let table: { count: number } | null;
  try {
    table = tableStatement.get();
  } finally {
    tableStatement.finalize();
  }
  if (table?.count !== 1) return { initialized: false, version: 0 };

  const versionStatement = database.prepare<{ version: number | null }, []>(
    'SELECT max(version) AS version FROM schema_migrations',
  );
  let row: { version: number | null } | null;
  try {
    row = versionStatement.get();
  } finally {
    versionStatement.finalize();
  }
  const version = row?.version ?? 0;
  if (!Number.isSafeInteger(version) || version < 0) {
    throw new Error('Current migration schema version is invalid');
  }
  return { initialized: true, version };
}

function inspectMigrationSchema(database: Database): MigrationSchemaState {
  const metadata = inspectMigrationMetadata(database);
  if (!metadata.initialized || metadata.version === 0) {
    const manifest = inspectLegacySchema(database);
    if (
      manifest.tables.length === 0 &&
      manifest.triggers.length === 0 &&
      manifest.views.length === 0 &&
      manifest.userVersion === 0 &&
      !manifest.sqliteInternals.sequenceTable
    ) {
      return metadata.initialized
        ? metadata
        : { initialized: false, version: 0, unmanaged: 'empty' };
    }
    if (legacySchemaChecksum(manifest) === LEGACY_1X_SCHEMA_CHECKSUM) {
      return {
        initialized: metadata.initialized,
        version: 0,
        unmanaged: 'legacy-1x',
        legacyDataChecksum: legacyDataChecksum(database, manifest),
      };
    }
    throw new MigrationError(
      'unsupported_unmanaged_schema',
      'Unmanaged SQLite schema does not match the published 1.x baseline',
    );
  }
  return metadata;
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

function readDataVersion(database: Database): number {
  const statement = database.prepare<{ data_version: number }, []>(
    'PRAGMA data_version',
  );
  let value: number | undefined;
  try {
    value = statement.get()?.data_version;
  } finally {
    statement.finalize();
  }
  if (!Number.isSafeInteger(value) || value === undefined || value < 0) {
    throw new MigrationError(
      'database_changed_during_backup',
      'SQLite data_version could not be validated around migration backup',
    );
  }
  return value;
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
    ((path: string, databaseOptions: { create: true; readwrite: true }) => {
      const database = new Database(path, databaseOptions);
      try {
        configureSqliteConnection(database, 'migration-bootstrap');
        return database;
      } catch (error) {
        database.close(true);
        throw error;
      }
    });
  const migrate =
    options.runMigrations ??
    ((database: MigrationBootstrapDatabase, migrations: readonly Migration[]) =>
      runMigrations(database as Database, migrations));
  const usesProductionRegistry =
    options.migrations === undefined &&
    options.openDatabase === undefined &&
    options.runMigrations === undefined &&
    options.inspectSchema === undefined;
  const usesRealDatabase = options.openDatabase === undefined;
  const inspect =
    options.inspectSchema ??
    ((database: MigrationBootstrapDatabase) =>
      usesProductionRegistry
        ? inspectMigrationSchema(database as Database)
        : inspectMigrationMetadata(database as Database));
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
  const configuredMigrations =
    options.migrations ?? (usesProductionRegistry ? MIGRATIONS : []);
  const database = openDatabase(resolvedPath.databasePath, {
    create: true,
    readwrite: true,
  });

  let phase: 'preflight' | 'backup' | 'migration' = 'preflight';
  let backup: MigrationBackup | undefined;
  let migrationMutationStarted = false;
  let failed = false;
  let failure: unknown;
  try {
    const migrations = captureMigrationRegistry(configuredMigrations);
    validateMigrationRegistry(migrations);
    const schema = inspect(database);
    const targetVersion = migrations.at(-1)?.version ?? 0;
    let baselineDataBefore: string | undefined;
    if (usesProductionRegistry && targetVersion === 1 && schema.version >= 1) {
      const manifest = inspectLegacySchema(database as Database);
      if (legacySchemaChecksum(manifest) !== LEGACY_1X_SCHEMA_CHECKSUM) {
        throw new MigrationError(
          'checksum_mismatch',
          'Published 1.x schema no longer matches its frozen baseline',
        );
      }
      baselineDataBefore = legacyDataChecksum(database as Database, manifest);
    }
    const needsBackup = !schema.initialized || schema.version < targetVersion;
    const dataVersionBeforeBackup =
      needsBackup && usesRealDatabase
        ? readDataVersion(database as Database)
        : undefined;
    if (needsBackup) {
      phase = 'backup';
      backup = backupDatabase({
        database,
        sourceDatabasePath: resolvedPath.databasePath,
        sourceSchemaVersion: schema.version,
        targetSchemaVersion: targetVersion,
      });
      phase = 'migration';
      if (
        dataVersionBeforeBackup !== undefined &&
        readDataVersion(database as Database) !== dataVersionBeforeBackup
      ) {
        throw new MigrationError(
          'database_changed_during_backup',
          'SQLite database changed while the migration backup was created',
        );
      }
    }

    phase = 'migration';
    if (usesProductionRegistry && schema.unmanaged === 'legacy-1x') {
      adoptUnmanagedMigration(
        database as Database,
        LEGACY_1X_BASELINE_MIGRATION,
        {
          validateUnmanagedSchema(candidate) {
            const manifest = inspectLegacySchema(candidate);
            if (
              legacySchemaChecksum(manifest) !== LEGACY_1X_SCHEMA_CHECKSUM ||
              legacyDataChecksum(candidate, manifest) !==
                schema.legacyDataChecksum
            ) {
              throw new MigrationError(
                'unsupported_unmanaged_schema',
                'Unmanaged SQLite database changed during baseline adoption',
              );
            }
          },
          allowExistingEmptyMetadata: schema.initialized,
          onBeforeMutation() {
            migrationMutationStarted = true;
          },
        },
      );
    }
    migrationMutationStarted = true;
    await migrate(database, migrations);
    if (usesProductionRegistry) {
      // A second no-op pass revalidates the persisted migration names and
      // checksums after the mutating pass, instead of assuming its writes
      // survived exactly as intended.
      runMigrations(database as Database, migrations);
      if (targetVersion === 1) {
        const manifest = inspectLegacySchema(database as Database);
        if (legacySchemaChecksum(manifest) !== LEGACY_1X_SCHEMA_CHECKSUM) {
          throw new MigrationError(
            'checksum_mismatch',
            'Migrated 1.x schema does not match the frozen baseline',
          );
        }
        const dataAfter = legacyDataChecksum(database as Database, manifest);
        const expectedData = schema.legacyDataChecksum ?? baselineDataBefore;
        if (expectedData !== undefined && dataAfter !== expectedData) {
          throw new MigrationError(
            'migration_failed',
            'Migration changed 1.x baseline data unexpectedly',
          );
        }
      }
    }
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

  if (!migrationMutationStarted) {
    if (closeFailed) {
      throw new AggregateError(
        [failure, closeError],
        'Database changed before migration and close failed',
      );
    }
    throw failure;
  }

  if (closeFailed) {
    throw new MigrationRecoveryError(
      'migration_failed_recovery_failed',
      resolvedPath.databasePath,
      'Database migration failed and recovery was not attempted because close failed',
      {
        cause: new AggregateError([failure, closeError]),
        backup,
      },
    );
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
