import { lstat, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import {
  FixedDatabaseClock,
  type DatabaseClock,
  type DatabaseConnection,
} from '../../src/persistence/database-clock';
import type {
  DatabaseAccessMode,
  DatabaseProvider,
} from '../../src/persistence/database-provider';
import { createTestDatabaseProvider } from './database-provider-testing';
import {
  MIGRATIONS,
  bootstrapMigrations,
} from '../../src/persistence/migration-bootstrap';
import { DataDirectoryInstanceLock } from '../../src/runtime/data-directory-instance-lock';
import {
  createLegacyFixture,
  type LegacyFixtureVariant,
} from '../../scripts/create-legacy-fixture';

export type TestDatabaseKind =
  | 'empty'
  | 'migrated'
  | 'legacy-1x'
  | 'wal-uncheckpointed'
  | 'corrupt-migration';

export type RawTestConnectionRole = 'read-only' | 'lock-holder';

export class TestDatabaseClock implements DatabaseClock {
  #value: number;

  constructor(value = 1_700_000_000_000) {
    this.#value = requireSafeInteger(value);
  }

  now(connection: DatabaseConnection): number {
    return new FixedDatabaseClock(this.#value).now(connection);
  }

  set(value: number): void {
    this.#value = requireSafeInteger(value);
  }

  advance(delta: number): void {
    const safeDelta = requireSafeInteger(delta);
    this.#value = requireSafeInteger(this.#value + safeDelta);
  }
}

export interface TestDatabase {
  readonly dataDirectory: string;
  readonly databasePath: string;
  readonly provider: DatabaseProvider;
  readonly clock: TestDatabaseClock;
  holdBusyLock(): () => void;
  acquireConflictingInstanceLock(): Promise<never>;
  restart(): Promise<void>;
  close(): Promise<void>;
}

export interface TestDatabaseCleanupFaults {
  readonly afterProviderClose?: Error;
  readonly afterLockRelease?: Error;
  readonly afterDirectoryRemove?: Error;
}

export interface CreateTestDatabaseOptions {
  readonly kind?: TestDatabaseKind;
  readonly schemaVersion?: 0 | 1;
  readonly accessMode?: DatabaseAccessMode;
  readonly now?: number;
  readonly clock?: TestDatabaseClock;
  readonly migrationFailure?: Error;
  readonly legacyVariant?: LegacyFixtureVariant;
  readonly observeDataDirectory?: (dataDirectory: string) => void;
  readonly observeMigrationBootstrap?: (
    stage: 'preparation' | 'startup',
  ) => void;
  readonly observeMigrationRecovery?: (
    databasePath: string,
    error: unknown,
  ) => void;
  readonly cleanupFaults?: TestDatabaseCleanupFaults;
}

type DirectoryIdentity = Readonly<{ dev: number; ino: number }>;
type AuxiliaryConnection = {
  readonly database: Database;
  readonly rollback: boolean;
  released: boolean;
};
type TestDatabaseLifecycle = {
  state: 'open' | 'restarting' | 'closing' | 'closed';
  readonly resources: Set<AuxiliaryConnection>;
};

const databaseLifecycles = new WeakMap<TestDatabase, TestDatabaseLifecycle>();

function requireSafeInteger(value: number): number {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError('Test database clock requires a safe integer');
  }
  return value;
}

function isThenable(value: unknown): boolean {
  return (
    ((typeof value === 'object' && value !== null) ||
      typeof value === 'function') &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

async function removeOwnedDirectory(
  path: string,
  identity: DirectoryIdentity,
): Promise<void> {
  const current = await lstat(path);
  if (
    !current.isDirectory() ||
    current.isSymbolicLink() ||
    current.dev !== identity.dev ||
    current.ino !== identity.ino
  ) {
    throw new Error('Test database directory identity changed before cleanup');
  }
  await rm(path, { recursive: true, force: false });
}

function releaseAuxiliaryConnection(resource: AuxiliaryConnection): unknown[] {
  if (resource.released) return [];
  const errors: unknown[] = [];
  if (resource.rollback) {
    try {
      resource.database.exec('ROLLBACK');
    } catch (error) {
      errors.push(error);
    }
  }
  try {
    resource.database.close(true);
    resource.released = true;
  } catch (error) {
    errors.push(error);
  }
  return errors;
}

function requireOpenLifecycle(
  testDatabase: TestDatabase,
): TestDatabaseLifecycle {
  const lifecycle = databaseLifecycles.get(testDatabase);
  if (lifecycle?.state !== 'open') {
    throw new Error('Test database is closing or closed');
  }
  return lifecycle;
}

function prepareUncheckpointedWal(
  databasePath: string,
  resources: Set<AuxiliaryConnection>,
): void {
  const reader = new Database(databasePath, { readwrite: true });
  const readerResource = { database: reader, rollback: true, released: false };
  try {
    reader.exec('PRAGMA busy_timeout = 0');
    reader.exec('PRAGMA journal_mode = WAL');
    reader.exec('PRAGMA wal_autocheckpoint = 0');
    reader.exec('BEGIN');
    reader.query('SELECT count(*) FROM audit').get();
    resources.add(readerResource);

    const writer = new Database(databasePath, { readwrite: true });
    try {
      writer.exec('PRAGMA busy_timeout = 0');
      writer
        .query(
          `INSERT INTO audit
             (session_id, tool_use_id, tool_name, behavior, reason, at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          'wal-fixture-session',
          'wal-fixture-use',
          'Fixture',
          'allow',
          null,
          1_700_000_000_500,
        );
    } finally {
      writer.close(true);
    }
  } catch (error) {
    resources.delete(readerResource);
    const cleanupErrors = releaseAuxiliaryConnection(readerResource);
    if (cleanupErrors.length === 0) throw error;
    throw new AggregateError(
      [error, ...cleanupErrors],
      'WAL fixture preparation and cleanup failed',
    );
  }
}

async function prepareScenario(
  databasePath: string,
  kind: TestDatabaseKind | 'schema-version-zero',
  options: CreateTestDatabaseOptions,
  resources: Set<AuxiliaryConnection>,
): Promise<void> {
  if (kind === 'legacy-1x' || kind === 'wal-uncheckpointed') {
    createLegacyFixture(databasePath, {
      variant: options.legacyVariant ?? 'normal',
    });
  }
  if (kind === 'schema-version-zero') return;

  if (kind === 'migrated' || kind === 'corrupt-migration') {
    await bootstrapMigrations(databasePath);
    options.observeMigrationBootstrap?.('preparation');
  }

  if (kind === 'wal-uncheckpointed') {
    prepareUncheckpointedWal(databasePath, resources);
  }

  if (options.migrationFailure !== undefined) {
    const injectedFailure = options.migrationFailure;
    try {
      await bootstrapMigrations(databasePath, {
        migrations: [
          ...MIGRATIONS,
          {
            version: 2,
            name: 'test_injected_failure',
            source: 'SELECT 1;',
            up() {
              throw injectedFailure;
            },
          },
        ],
      });
    } catch (error) {
      options.observeMigrationRecovery?.(databasePath, error);
      throw error;
    }
    options.observeMigrationBootstrap?.('startup');
    return;
  }

  if (kind === 'corrupt-migration') {
    const corrupt = new Database(databasePath, { readwrite: true });
    try {
      corrupt
        .query('UPDATE schema_migrations SET checksum = ? WHERE version = 1')
        .run('0'.repeat(64));
    } finally {
      corrupt.close(true);
    }
  }
  await bootstrapMigrations(databasePath);
  options.observeMigrationBootstrap?.('startup');
}

function resolveKind(
  options: CreateTestDatabaseOptions,
): TestDatabaseKind | 'schema-version-zero' {
  if (options.schemaVersion !== undefined && options.kind !== undefined) {
    throw new TypeError('Specify either kind or schemaVersion, not both');
  }
  if (
    options.schemaVersion !== undefined &&
    options.schemaVersion !== 0 &&
    options.schemaVersion !== 1
  ) {
    throw new RangeError('Unknown test database schema version');
  }
  if (options.schemaVersion === 0) return 'schema-version-zero';
  if (options.schemaVersion === 1) return 'migrated';
  const kind = options.kind ?? 'migrated';
  if (
    ![
      'empty',
      'migrated',
      'legacy-1x',
      'wal-uncheckpointed',
      'corrupt-migration',
    ].includes(kind)
  ) {
    throw new TypeError('Unknown test database kind');
  }
  return kind;
}

export function withRawTestConnection<T>(
  testDatabase: TestDatabase,
  role: RawTestConnectionRole,
  operation: (database: Database) => T,
): T {
  const lifecycle = requireOpenLifecycle(testDatabase);
  const raw =
    role === 'read-only'
      ? new Database(testDatabase.databasePath, {
          readonly: true,
          create: false,
        })
      : new Database(testDatabase.databasePath, { readwrite: true });
  const resource = { database: raw, rollback: false, released: false };
  lifecycle.resources.add(resource);
  let result: T | undefined;
  let operationError: unknown;
  try {
    if (role === 'read-only') {
      raw.exec('PRAGMA foreign_keys = ON');
      raw.exec('PRAGMA trusted_schema = OFF');
      raw.exec('PRAGMA query_only = ON');
    } else {
      raw.exec('PRAGMA busy_timeout = 0');
      raw.exec('PRAGMA foreign_keys = ON');
      raw.exec('PRAGMA trusted_schema = OFF');
    }
    result = operation(raw);
    if (isThenable(result)) {
      void Promise.resolve(result).catch(() => undefined);
      throw new TypeError('Raw test connection callback must be synchronous');
    }
  } catch (error) {
    operationError = error;
  }
  const cleanupErrors = releaseAuxiliaryConnection(resource);
  if (resource.released) lifecycle.resources.delete(resource);
  if (operationError !== undefined) {
    if (cleanupErrors.length === 0) throw operationError;
    throw new AggregateError(
      [operationError, ...cleanupErrors],
      'Raw test connection operation and cleanup failed',
    );
  }
  if (cleanupErrors.length === 1) throw cleanupErrors[0];
  if (cleanupErrors.length > 1) {
    throw new AggregateError(
      cleanupErrors,
      'Raw test connection cleanup failed',
    );
  }
  return result as T;
}

export async function createTestDatabase(
  options: CreateTestDatabaseOptions = {},
): Promise<TestDatabase> {
  const dataDirectory = await mkdtemp(
    join(tmpdir(), 'colorful-code-test-database-'),
  );
  const initialStat = await lstat(dataDirectory);
  const directoryIdentity = Object.freeze({
    dev: initialStat.dev,
    ino: initialStat.ino,
  });
  const databasePath = join(dataDirectory, 'colorful-code.db');
  let lock: DataDirectoryInstanceLock | undefined;
  let provider: DatabaseProvider | undefined;
  const auxiliaryConnections = new Set<AuxiliaryConnection>();
  try {
    options.observeDataDirectory?.(dataDirectory);
    lock = await DataDirectoryInstanceLock.acquire(dataDirectory);
    const kind = resolveKind(options);
    if (
      options.legacyVariant !== undefined &&
      kind !== 'legacy-1x' &&
      kind !== 'wal-uncheckpointed'
    ) {
      throw new TypeError(
        'legacyVariant requires a legacy-1x or wal-uncheckpointed database',
      );
    }
    if (options.accessMode === 'read-only' && kind === 'schema-version-zero') {
      throw new TypeError('A read-only test database requires a migrated file');
    }
    await prepareScenario(databasePath, kind, options, auxiliaryConnections);
    const clock = options.clock ?? new TestDatabaseClock(options.now);
    provider = createTestDatabaseProvider(databasePath, {
      clock,
      accessMode: options.accessMode,
    });

    let closePromise: Promise<void> | undefined;
    let restartPromise: Promise<void> | undefined;
    const lifecycle: TestDatabaseLifecycle = {
      state: 'open',
      resources: auxiliaryConnections,
    };
    const handle: TestDatabase = {
      dataDirectory,
      databasePath,
      get provider() {
        return provider!;
      },
      clock,
      holdBusyLock(): () => void {
        const currentLifecycle = requireOpenLifecycle(handle);
        const database = new Database(databasePath, { readwrite: true });
        const resource = { database, rollback: true, released: false };
        try {
          database.exec('PRAGMA busy_timeout = 0');
          database.exec('BEGIN IMMEDIATE');
          currentLifecycle.resources.add(resource);
        } catch (error) {
          const cleanupErrors = releaseAuxiliaryConnection(resource);
          if (cleanupErrors.length === 0) throw error;
          throw new AggregateError(
            [error, ...cleanupErrors],
            'Busy lock acquisition and cleanup failed',
          );
        }
        let released = false;
        return () => {
          if (released || resource.released) {
            released = true;
            return;
          }
          const errors = releaseAuxiliaryConnection(resource);
          if (resource.released) {
            currentLifecycle.resources.delete(resource);
            released = true;
          }
          if (errors.length === 0) {
            return;
          }
          throw errors.length === 1
            ? errors[0]
            : new AggregateError(errors, 'Busy lock release failed');
        };
      },
      async acquireConflictingInstanceLock(): Promise<never> {
        requireOpenLifecycle(handle);
        const unexpected =
          await DataDirectoryInstanceLock.acquire(dataDirectory);
        await unexpected.release();
        throw new Error('Expected the existing Instance Lock to conflict');
      },
      restart(): Promise<void> {
        if (restartPromise !== undefined) return restartPromise;
        requireOpenLifecycle(handle);
        lifecycle.state = 'restarting';
        restartPromise = (async () => {
          const errors: unknown[] = [];
          for (const resource of [...auxiliaryConnections]) {
            errors.push(...releaseAuxiliaryConnection(resource));
            if (resource.released) auxiliaryConnections.delete(resource);
          }
          if (errors.length > 0) {
            lifecycle.state = 'open';
            restartPromise = undefined;
            throw errors.length === 1
              ? errors[0]
              : new AggregateError(
                  errors,
                  'Test database restart resource cleanup failed',
                );
          }

          try {
            await provider!.close();
          } catch (error) {
            lifecycle.state = 'open';
            restartPromise = undefined;
            throw error;
          }
          try {
            await lock!.release();
          } catch (error) {
            lifecycle.state = 'open';
            restartPromise = undefined;
            throw error;
          }
          lock = undefined;
          try {
            lock = await DataDirectoryInstanceLock.acquire(dataDirectory);
            await bootstrapMigrations(databasePath);
            provider = createTestDatabaseProvider(databasePath, {
              clock,
              accessMode: options.accessMode,
            });
            lifecycle.state = 'open';
          } catch (error) {
            const cleanupErrors: unknown[] = [error];
            if (lock !== undefined) {
              try {
                await lock.release();
                lock = undefined;
              } catch (cleanupError) {
                cleanupErrors.push(cleanupError);
              }
            }
            try {
              await removeOwnedDirectory(dataDirectory, directoryIdentity);
              lifecycle.state = 'closed';
            } catch (cleanupError) {
              cleanupErrors.push(cleanupError);
            }
            throw cleanupErrors.length === 1
              ? cleanupErrors[0]
              : new AggregateError(
                  cleanupErrors,
                  'Test database restart and cleanup failed',
                );
          } finally {
            restartPromise = undefined;
          }
        })();
        return restartPromise;
      },
      close(): Promise<void> {
        if (closePromise !== undefined) return closePromise;
        if (lifecycle.state === 'restarting' && restartPromise !== undefined) {
          closePromise = restartPromise.then(() => {
            closePromise = undefined;
            return handle.close();
          });
          return closePromise;
        }
        lifecycle.state = 'closing';
        closePromise = Promise.resolve().then(async () => {
          const errors: unknown[] = [];
          for (const resource of [...auxiliaryConnections]) {
            const resourceErrors = releaseAuxiliaryConnection(resource);
            errors.push(...resourceErrors);
            if (resource.released) auxiliaryConnections.delete(resource);
          }

          let providerClosed = false;
          try {
            await provider!.close();
            providerClosed = true;
            if (options.cleanupFaults?.afterProviderClose) {
              errors.push(options.cleanupFaults.afterProviderClose);
            }
          } catch (error) {
            errors.push(error);
          }

          let lockReleased = false;
          if (providerClosed && auxiliaryConnections.size === 0) {
            try {
              await lock!.release();
              lockReleased = true;
              if (options.cleanupFaults?.afterLockRelease) {
                errors.push(options.cleanupFaults.afterLockRelease);
              }
            } catch (error) {
              errors.push(error);
            }
          }

          let directoryRemoved = false;
          if (lockReleased) {
            try {
              await removeOwnedDirectory(dataDirectory, directoryIdentity);
              directoryRemoved = true;
              if (options.cleanupFaults?.afterDirectoryRemove) {
                errors.push(options.cleanupFaults.afterDirectoryRemove);
              }
            } catch (error) {
              errors.push(error);
            }
          }

          if (directoryRemoved) lifecycle.state = 'closed';

          if (errors.length === 1) throw errors[0];
          if (errors.length > 1) {
            throw new AggregateError(errors, 'Test database cleanup failed');
          }
        });
        return closePromise;
      },
    };
    databaseLifecycles.set(handle, lifecycle);
    return Object.freeze(handle);
  } catch (error) {
    const errors: unknown[] = [error];
    for (const resource of [...auxiliaryConnections]) {
      const cleanupErrors = releaseAuxiliaryConnection(resource);
      errors.push(...cleanupErrors);
      if (cleanupErrors.length === 0) auxiliaryConnections.delete(resource);
    }

    let providerClosed = provider === undefined;
    if (provider !== undefined) {
      try {
        await provider.close();
        providerClosed = true;
      } catch (cleanupError) {
        errors.push(cleanupError);
      }
    }

    let lockReleased = lock === undefined;
    if (
      lock !== undefined &&
      providerClosed &&
      auxiliaryConnections.size === 0
    ) {
      try {
        await lock.release();
        lockReleased = true;
      } catch (cleanupError) {
        errors.push(cleanupError);
      }
    }

    if (lockReleased) {
      try {
        await removeOwnedDirectory(dataDirectory, directoryIdentity);
      } catch (cleanupError) {
        errors.push(cleanupError);
      }
    }
    if (errors.length === 1) throw error;
    throw new AggregateError(
      errors,
      'Test database creation and cleanup failed',
    );
  }
}

export async function useTestDatabase<T>(
  options: CreateTestDatabaseOptions,
  operation: (database: TestDatabase) => T | Promise<T>,
): Promise<T> {
  const database = await createTestDatabase(options);
  let result: T | undefined;
  let bodyError: unknown;
  let bodyFailed = false;
  try {
    result = await operation(database);
  } catch (error) {
    bodyFailed = true;
    bodyError = error;
  }

  let cleanupError: unknown;
  try {
    await database.close();
  } catch (error) {
    cleanupError = error;
  }

  if (bodyFailed && cleanupError !== undefined) {
    const cleanupErrors =
      cleanupError instanceof AggregateError
        ? cleanupError.errors
        : [cleanupError];
    throw new AggregateError(
      [bodyError, ...cleanupErrors],
      'Test database body and cleanup failed',
    );
  }
  if (bodyFailed) throw bodyError;
  if (cleanupError !== undefined) throw cleanupError;
  return result as T;
}
