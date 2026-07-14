import 'reflect-metadata';
import type { DynamicModule, NestApplicationOptions } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { AppModule } from './app.module';
import {
  loadServerDevelopmentEnvFiles,
  loadServerEnvironment,
} from './config/environment';
import { buildCorsOptions } from './config/cors';
import type { ServerEnvironment } from './config/environment';
import {
  createDatabaseProvider,
  type DatabaseProvider,
} from './persistence/database-provider';
import { DatabasePathError } from './persistence/database-path';
import { MigrationBackupRecoveryError } from './persistence/migration-backup-recovery';
import { MigrationRecoveryError } from './persistence/migration-bootstrap';
import { MigrationError } from './persistence/migration-framework';
import { SqliteConfigurationError } from './persistence/sqlite-configuration';
import { DataDirectoryLockConflictError } from './runtime/data-directory-instance-lock';
import {
  type DaemonApplication,
  type StartDaemonOptions,
  startDaemon,
} from './runtime/daemon-lifecycle';

export interface BootstrapDependencies {
  loadDevelopmentEnvFiles: () => void;
  loadEnvironment: () => ServerEnvironment;
  createNestApplication: (
    environment: ServerEnvironment,
    provider: DatabaseProvider,
  ) => Promise<DaemonApplication>;
  startDaemon: (options: StartDaemonOptions) => Promise<DaemonApplication>;
}

const defaultDependencies: BootstrapDependencies = {
  loadDevelopmentEnvFiles: loadServerDevelopmentEnvFiles,
  loadEnvironment: loadServerEnvironment,
  createNestApplication,
  startDaemon,
};

export async function bootstrap(
  dependencies: BootstrapDependencies = defaultDependencies,
): Promise<DaemonApplication> {
  dependencies.loadDevelopmentEnvFiles();
  const serverEnvironment = dependencies.loadEnvironment();

  return dependencies.startDaemon({
    databasePath: serverEnvironment.databasePath,
    createProvider: createDatabaseProvider,
    createApplication: (databasePath, provider) => {
      return dependencies.createNestApplication(
        {
          ...serverEnvironment,
          databasePath,
        },
        provider,
      );
    },
  });
}

export type NestApplicationCreator = (
  module: DynamicModule,
  adapter: FastifyAdapter,
  options: Pick<NestApplicationOptions, 'abortOnError'>,
) => Promise<NestFastifyApplication>;

export async function createNestApplication(
  serverEnvironment: ServerEnvironment,
  provider: DatabaseProvider,
  createApplication: NestApplicationCreator = (module, adapter, options) =>
    NestFactory.create<NestFastifyApplication>(module, adapter, options),
): Promise<DaemonApplication> {
  const adapter = new FastifyAdapter();

  const app = await createApplication(
    AppModule.forRoot(serverEnvironment, provider),
    adapter,
    {
      abortOnError: false,
    },
  );

  app.enableCors(buildCorsOptions(serverEnvironment.corsOrigins));
  app.enableShutdownHooks();

  return {
    listen: async () => {
      await app.listen(serverEnvironment.port, serverEnvironment.host);
    },
    close: () => app.close(),
    onClose: (callback) => {
      adapter.getInstance().addHook('onClose', async () => callback());
    },
  };
}

type ErrorWriter = (...args: unknown[]) => void;
type ProcessState = { exitCode?: string | number | null };

const SAFE_SQLITE_ERROR_CODES = new Set([
  'pragma_failed',
  'pragma_mismatch',
  'wal_unavailable',
  'unsupported_runtime',
]);
const SAFE_DATABASE_PATH_ERROR_CODES = new Set([
  'in_memory_database_unsupported',
  'unsupported_file_uri',
  'symbolic_link_database',
]);
const SAFE_MIGRATION_ERROR_CODES = new Set([
  'invalid_registry',
  'database_newer_than_program',
  'unsupported_unmanaged_schema',
  'database_changed_during_backup',
  'unknown_applied_migration',
  'checksum_mismatch',
  'migration_metadata_invalid',
  'migration_failed',
]);
const SAFE_MIGRATION_RECOVERY_ERROR_CODES = new Set([
  'backup_failed',
  'migration_failed_recovered',
  'migration_failed_recovery_failed',
]);
const SAFE_BACKUP_RECOVERY_ERROR_CODES = new Set([
  'backup_invalid',
  'recovery_refused',
  'quarantine_failed',
  'recovery_failed',
]);
const SAFE_SQLITE_ROLES = new Set([
  'business-read-write',
  'business-read-only',
  'migration-bootstrap',
  'migration-snapshot-read-only',
  'unknown',
]);
const SAFE_SQLITE_PRAGMAS = new Set([
  'busy_timeout',
  'foreign_keys',
  'journal_mode',
  'query_only',
  'synchronous',
  'temp_store',
  'trusted_schema',
]);

function safeBootstrapErrorMessage(error: unknown): string {
  if (
    error instanceof DataDirectoryLockConflictError &&
    error.code === 'data_directory_in_use'
  ) {
    return 'Another Colorful Code daemon is already using this data directory';
  }
  if (
    error instanceof DatabasePathError &&
    SAFE_DATABASE_PATH_ERROR_CODES.has(error.code)
  ) {
    return `Database startup rejected [code=${error.code}]`;
  }
  if (
    error instanceof MigrationError &&
    SAFE_MIGRATION_ERROR_CODES.has(error.code)
  ) {
    return `Database migration rejected [code=${error.code}]`;
  }
  if (
    error instanceof MigrationRecoveryError &&
    SAFE_MIGRATION_RECOVERY_ERROR_CODES.has(error.code)
  ) {
    return `Database migration recovery failed [code=${error.code}]`;
  }
  if (
    error instanceof MigrationBackupRecoveryError &&
    SAFE_BACKUP_RECOVERY_ERROR_CODES.has(error.code)
  ) {
    return `Database backup recovery failed [code=${error.code}]`;
  }
  if (
    error instanceof SqliteConfigurationError &&
    SAFE_SQLITE_ERROR_CODES.has(error.code) &&
    SAFE_SQLITE_ROLES.has(error.role)
  ) {
    const pragma =
      error.pragma !== undefined && SAFE_SQLITE_PRAGMAS.has(error.pragma)
        ? `, pragma=${error.pragma}`
        : '';
    return `SQLite configuration rejected [code=${error.code}, role=${error.role}${pragma}]`;
  }
  return 'Colorful Code daemon failed to start';
}

export function reportBootstrapError(
  error: unknown,
  writeError: ErrorWriter = console.error,
  processState: ProcessState = process,
): void {
  writeError(safeBootstrapErrorMessage(error));
  processState.exitCode = 1;
}

// @ts-expect-error Bun supports import.meta.main; Nest's build target is CommonJS.
if (import.meta.main) {
  void bootstrap().catch((error: unknown) => reportBootstrapError(error));
}
