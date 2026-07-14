import { mkdirSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { Database } from 'bun:sqlite';
import {
  DatabaseFacadeRevokedError,
  SqliteDatabaseClock,
  createDatabaseConnectionFacade,
  revokeDatabaseConnectionFacade,
  type DatabaseClock,
  type DatabaseConnection,
  type WriteDatabaseConnection,
} from './database-clock';
import {
  configureDatabaseConnection,
  initializeLegacySchema,
} from './database';

export { DatabaseFacadeRevokedError };
export type { DatabaseClock, DatabaseConnection };

export class DatabaseProviderClosedError extends Error {
  constructor() {
    super('The database provider is closing or closed');
    this.name = 'DatabaseProviderClosedError';
  }
}

export class DatabaseProviderOwnershipError extends Error {
  readonly dataDirectory: string;

  constructor(dataDirectory: string) {
    super(`A database provider already owns data directory: ${dataDirectory}`);
    this.name = 'DatabaseProviderOwnershipError';
    this.dataDirectory = dataDirectory;
  }
}

export class NestedTransactionError extends Error {
  constructor() {
    super('Nested or concurrent database transactions are not supported');
    this.name = 'NestedTransactionError';
  }
}

export class AsyncTransactionCallbackError extends TypeError {
  constructor() {
    super('Database transaction callbacks must not return a Promise');
    this.name = 'AsyncTransactionCallbackError';
  }
}

export class DatabaseBusyRetryExhaustedError extends Error {
  readonly attempts: number;

  constructor(attempts: number, cause: unknown) {
    super(`Database remained busy after ${String(attempts)} attempts`, {
      cause,
    });
    this.name = 'DatabaseBusyRetryExhaustedError';
    this.attempts = attempts;
  }
}

export interface TransactionContext {
  readonly database: WriteDatabaseConnection;
  readonly clock: DatabaseClock;
  readonly now: number;
}

export interface TransactionRetryOptions {
  readonly maxRetries: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly jitterRatio: number;
}

export interface TransactionOptions {
  readonly retry?: TransactionRetryOptions;
}

export type SynchronousTransactionResult<T> =
  T extends PromiseLike<unknown> ? never : T;

export interface DatabaseProvider {
  readonly dialect: 'sqlite';
  readonly clock: DatabaseClock;

  read<T>(operation: (connection: DatabaseConnection) => T): T;
  transaction<T>(
    operation: (
      transaction: TransactionContext,
    ) => SynchronousTransactionResult<T>,
    options?: TransactionOptions,
  ): Promise<T>;
  close(): Promise<void>;
}

type ProviderState = 'open' | 'closing' | 'closed';

interface DatabaseProviderDependencies {
  readonly clock?: DatabaseClock;
  readonly connectionFactory: (databasePath: string) => Database;
  readonly configureConnection: (connection: Database) => void;
  readonly initializeSchema: (connection: Database) => void;
  readonly createClock: () => DatabaseClock;
  readonly closeConnection: (connection: Database) => void;
  readonly executeTransactionControl: (
    connection: Database,
    statement: TransactionControlStatement,
  ) => void;
  readonly sleep: (delayMs: number) => Promise<void>;
  readonly random: () => number;
}

type TransactionControlStatement = 'BEGIN IMMEDIATE' | 'COMMIT' | 'ROLLBACK';

export interface TestDatabaseProviderOptions {
  readonly clock?: DatabaseClock;
  readonly connectionFactory?: (databasePath: string) => Database;
  readonly configureConnection?: (connection: Database) => void;
  readonly initializeSchema?: (connection: Database) => void;
  readonly createClock?: () => DatabaseClock;
  readonly closeConnection?: (connection: Database) => void;
  readonly executeTransactionControl?: (
    connection: Database,
    statement: TransactionControlStatement,
  ) => void;
  readonly sleep?: (delayMs: number) => Promise<void>;
  readonly random?: () => number;
}

const dataDirectoryOwners = new Map<string, symbol>();

class SqliteDatabaseProvider implements DatabaseProvider {
  readonly dialect = 'sqlite' as const;
  readonly clock: DatabaseClock;
  readonly #connection: Database;
  readonly #closeConnection: (connection: Database) => void;
  readonly #dataDirectory: string;
  readonly #owner: symbol;
  readonly #executeTransactionControl: DatabaseProviderDependencies['executeTransactionControl'];
  readonly #sleep: DatabaseProviderDependencies['sleep'];
  readonly #random: DatabaseProviderDependencies['random'];
  #state: ProviderState = 'open';
  #closePromise?: Promise<void>;
  #transactionCallbackActive = false;

  constructor(
    connection: Database,
    clock: DatabaseClock,
    closeConnection: (connection: Database) => void,
    dataDirectory: string,
    owner: symbol,
    executeTransactionControl: DatabaseProviderDependencies['executeTransactionControl'],
    sleep: DatabaseProviderDependencies['sleep'],
    random: DatabaseProviderDependencies['random'],
  ) {
    this.#connection = connection;
    this.clock = clock;
    this.#closeConnection = closeConnection;
    this.#dataDirectory = dataDirectory;
    this.#owner = owner;
    this.#executeTransactionControl = executeTransactionControl;
    this.#sleep = sleep;
    this.#random = random;
  }

  read<T>(operation: (connection: DatabaseConnection) => T): T {
    this.#assertOpen();
    const facade = createDatabaseConnectionFacade(this.#connection);
    try {
      return operation(facade);
    } finally {
      revokeDatabaseConnectionFacade(facade);
    }
  }

  transaction<T>(
    operation: (
      transaction: TransactionContext,
    ) => SynchronousTransactionResult<T>,
    options: TransactionOptions = {},
  ): Promise<T> {
    this.#assertOpen();
    if (this.#transactionCallbackActive) throw new NestedTransactionError();
    const retry = validateRetryOptions(options.retry);
    return this.#runTransactionWithRetry(operation, retry);
  }

  async #runTransactionWithRetry<T>(
    operation: (
      transaction: TransactionContext,
    ) => SynchronousTransactionResult<T>,
    retry: TransactionRetryOptions | undefined,
  ): Promise<T> {
    const maximumAttempts = (retry?.maxRetries ?? 0) + 1;
    for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
      this.#assertOpen();
      try {
        return this.#runTransactionAttempt(operation);
      } catch (error) {
        if (!retry || !isBusyError(error)) throw error;
        if (attempt === maximumAttempts) {
          throw new DatabaseBusyRetryExhaustedError(attempt, error);
        }
        this.#assertOpen();
        await this.#sleep(computeRetryDelay(retry, attempt, this.#random));
        this.#assertOpen();
      }
    }
    throw new Error('Unreachable database transaction retry state');
  }

  #runTransactionAttempt<T>(
    operation: (
      transaction: TransactionContext,
    ) => SynchronousTransactionResult<T>,
  ): T {
    const database = createDatabaseConnectionFacade(this.#connection, 'write');
    let transactionStarted = false;
    try {
      this.#executeTransactionControl(this.#connection, 'BEGIN IMMEDIATE');
      transactionStarted = true;
      const now = this.clock.now(database);
      this.#transactionCallbackActive = true;
      let result: SynchronousTransactionResult<T>;
      try {
        result = operation(Object.freeze({ database, clock: this.clock, now }));
      } finally {
        this.#transactionCallbackActive = false;
      }
      if (isThenable(result)) throw new AsyncTransactionCallbackError();
      this.#executeTransactionControl(this.#connection, 'COMMIT');
      transactionStarted = false;
      return result as T;
    } catch (originalError) {
      if (transactionStarted) {
        try {
          this.#executeTransactionControl(this.#connection, 'ROLLBACK');
        } catch (rollbackError) {
          throw new AggregateError(
            [originalError, rollbackError],
            'Database transaction and rollback failed',
          );
        }
      }
      throw originalError;
    } finally {
      revokeDatabaseConnectionFacade(database);
    }
  }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#state = 'closing';
    this.#closePromise = (async () => {
      try {
        this.#closeConnection(this.#connection);
        releaseOwnership(this.#dataDirectory, this.#owner);
      } finally {
        this.#state = 'closed';
      }
    })();
    return this.#closePromise;
  }

  #assertOpen(): void {
    if (this.#state !== 'open') throw new DatabaseProviderClosedError();
  }
}

const defaultDependencies: DatabaseProviderDependencies = {
  connectionFactory: (databasePath) => new Database(databasePath),
  configureConnection: configureDatabaseConnection,
  initializeSchema: initializeLegacySchema,
  createClock: () => new SqliteDatabaseClock(),
  closeConnection: (connection) => connection.close(),
  executeTransactionControl: (connection, statement) =>
    connection.exec(statement),
  sleep: (delayMs) =>
    new Promise((resolveSleep) => setTimeout(resolveSleep, delayMs)),
  random: Math.random,
};

function isThenable(value: unknown): boolean {
  if (
    (typeof value !== 'object' || value === null) &&
    typeof value !== 'function'
  ) {
    return false;
  }
  return typeof (value as { then?: unknown }).then === 'function';
}

function isBusyError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = (error as { code?: unknown }).code;
  return code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED';
}

function validateRetryOptions(
  retry: TransactionRetryOptions | undefined,
): TransactionRetryOptions | undefined {
  if (retry === undefined) return undefined;
  if (!Number.isSafeInteger(retry.maxRetries) || retry.maxRetries < 0) {
    throw new RangeError('maxRetries must be a non-negative safe integer');
  }
  for (const [name, value] of [
    ['baseDelayMs', retry.baseDelayMs],
    ['maxDelayMs', retry.maxDelayMs],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError(`${name} must be a non-negative safe integer`);
    }
  }
  if (retry.maxDelayMs < retry.baseDelayMs) {
    throw new RangeError('maxDelayMs must be at least baseDelayMs');
  }
  if (
    !Number.isFinite(retry.jitterRatio) ||
    retry.jitterRatio < 0 ||
    retry.jitterRatio > 1
  ) {
    throw new RangeError('jitterRatio must be between 0 and 1');
  }
  return Object.freeze({ ...retry });
}

function computeRetryDelay(
  retry: TransactionRetryOptions,
  retryNumber: number,
  random: () => number,
): number {
  const exponential = Math.min(
    retry.maxDelayMs,
    retry.baseDelayMs * 2 ** (retryNumber - 1),
  );
  const randomValue = random();
  if (!Number.isFinite(randomValue) || randomValue < 0 || randomValue > 1) {
    throw new RangeError('Database retry random source must return [0, 1]');
  }
  const jitter = exponential * retry.jitterRatio * (randomValue * 2 - 1);
  return Math.max(
    0,
    Math.min(retry.maxDelayMs, Math.round(exponential + jitter)),
  );
}

function releaseOwnership(dataDirectory: string, owner: symbol): void {
  if (dataDirectoryOwners.get(dataDirectory) === owner) {
    dataDirectoryOwners.delete(dataDirectory);
  }
}

function createProvider(
  databasePath: string,
  overrides: TestDatabaseProviderOptions = {},
): DatabaseProvider {
  const normalizedPath = resolve(databasePath);
  const requestedDataDirectory = dirname(normalizedPath);
  mkdirSync(requestedDataDirectory, { recursive: true });
  const dataDirectory = realpathSync.native(requestedDataDirectory);
  const canonicalDatabasePath = join(dataDirectory, basename(normalizedPath));
  const owner = Symbol(dataDirectory);
  if (dataDirectoryOwners.has(dataDirectory)) {
    throw new DatabaseProviderOwnershipError(dataDirectory);
  }
  dataDirectoryOwners.set(dataDirectory, owner);

  const dependencies: DatabaseProviderDependencies = {
    ...defaultDependencies,
    ...overrides,
  };
  let connection: Database | undefined;
  try {
    connection = dependencies.connectionFactory(canonicalDatabasePath);
    dependencies.configureConnection(connection);
    dependencies.initializeSchema(connection);
    const clock = dependencies.clock ?? dependencies.createClock();
    return new SqliteDatabaseProvider(
      connection,
      clock,
      dependencies.closeConnection,
      dataDirectory,
      owner,
      dependencies.executeTransactionControl,
      dependencies.sleep,
      dependencies.random,
    );
  } catch (initializationError) {
    let closeError: unknown;
    if (connection) {
      try {
        dependencies.closeConnection(connection);
      } catch (error) {
        closeError = error;
      }
    }
    if (closeError === undefined) {
      releaseOwnership(dataDirectory, owner);
    }
    if (closeError !== undefined) {
      throw new AggregateError(
        [initializationError, closeError],
        'Database provider initialization and cleanup failed',
      );
    }
    throw initializationError;
  }
}

export function createInternalDatabaseProvider(
  databasePath: string,
): DatabaseProvider {
  return createProvider(databasePath);
}

export function createInternalTestDatabaseProvider(
  databasePath: string,
  options: TestDatabaseProviderOptions = {},
): DatabaseProvider {
  return createProvider(databasePath, options);
}
