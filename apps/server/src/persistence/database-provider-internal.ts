import { lstatSync, mkdirSync, realpathSync } from 'node:fs';
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
import { checkpointWal, type WalCheckpointResult } from './sqlite-checkpoint';
import {
  configureSqliteConnection,
  type SqliteConnectionConfiguration,
  type SqliteConnectionRole,
} from './sqlite-configuration';
import {
  createSqliteDiagnostics,
  type SqliteDiagnostics,
} from './sqlite-diagnostics';

export { DatabaseFacadeRevokedError };
export type { DatabaseClock, DatabaseConnection };

export class DatabaseProviderClosedError extends Error {
  constructor() {
    super('The database provider is closing or closed');
    this.name = 'DatabaseProviderClosedError';
  }
}

export class DatabaseReadOnlyError extends Error {
  constructor() {
    super('The database provider is read-only');
    this.name = 'DatabaseReadOnlyError';
  }
}

export class DatabaseProviderOwnershipError extends Error {
  readonly code = 'ownership_conflict' as const;

  constructor(dataDirectory: string) {
    super('A database provider already owns the data directory');
    this.name = 'DatabaseProviderOwnershipError';
    void dataDirectory;
  }
}

export type DatabaseProviderPathErrorCode =
  | 'directory_unavailable'
  | 'database_open_failed';

export class DatabaseProviderPathError extends Error {
  readonly code: DatabaseProviderPathErrorCode;

  constructor(code: DatabaseProviderPathErrorCode) {
    super(
      code === 'directory_unavailable'
        ? 'Database directory is unavailable'
        : 'Database could not be opened',
    );
    this.name = 'DatabaseProviderPathError';
    this.code = code;
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
  readonly accessMode: DatabaseAccessMode;
  readonly diagnostics: SqliteDiagnostics;
  readonly clock: DatabaseClock;
  readonly lastCheckpointResult: WalCheckpointResult | undefined;

  read<T>(operation: (connection: DatabaseConnection) => T): T;
  transaction<T>(
    operation: (
      transaction: TransactionContext,
    ) => SynchronousTransactionResult<T>,
    options?: TransactionOptions,
  ): Promise<T>;
  close(options?: DatabaseProviderCloseOptions): Promise<void>;
}

export interface DatabaseProviderCloseOptions {
  readonly checkpointSignal?: AbortSignal;
}

export type DatabaseAccessMode = 'read-write' | 'read-only';

export interface DatabaseProviderOptions {
  readonly accessMode?: DatabaseAccessMode;
}

type ProviderState = 'open' | 'closing' | 'closed';

interface DatabaseProviderDependencies {
  readonly clock?: DatabaseClock;
  readonly connectionFactory: (
    databasePath: string,
    accessMode: DatabaseAccessMode,
  ) => Database;
  readonly configureConnection: (
    connection: Database,
    role: SqliteConnectionRole,
  ) => SqliteConnectionConfiguration;
  readonly createDiagnostics: (
    connection: Database,
    configuration: SqliteConnectionConfiguration,
  ) => SqliteDiagnostics;
  readonly createClock: () => DatabaseClock;
  readonly closeConnection: (connection: Database) => void;
  readonly checkpointWal: (
    connection: Database,
    signal?: AbortSignal,
  ) => WalCheckpointResult;
  readonly releaseOwnership: (dataDirectory: string, owner: symbol) => void;
  readonly executeTransactionControl: (
    connection: Database,
    statement: TransactionControlStatement,
  ) => void;
  readonly sleep: (delayMs: number) => Promise<void>;
  readonly random: () => number;
}

type TransactionControlStatement = 'BEGIN IMMEDIATE' | 'COMMIT' | 'ROLLBACK';

class BeginTransactionBusyError extends Error {
  constructor(readonly sqliteError: unknown) {
    super('Database transaction could not begin because SQLite is busy');
    this.name = 'BeginTransactionBusyError';
  }
}

export interface DatabaseProviderDependencyOverrides {
  readonly clock?: DatabaseClock;
  readonly connectionFactory?: (
    databasePath: string,
    accessMode: DatabaseAccessMode,
  ) => Database;
  readonly configureConnection?: (
    connection: Database,
    role: SqliteConnectionRole,
  ) => SqliteConnectionConfiguration;
  readonly createDiagnostics?: (
    connection: Database,
    configuration: SqliteConnectionConfiguration,
  ) => SqliteDiagnostics;
  readonly createClock?: () => DatabaseClock;
  readonly closeConnection?: (connection: Database) => void;
  readonly checkpointWal?: (
    connection: Database,
    signal?: AbortSignal,
  ) => WalCheckpointResult;
  readonly releaseOwnership?: (dataDirectory: string, owner: symbol) => void;
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
  readonly accessMode: DatabaseAccessMode;
  readonly diagnostics: SqliteDiagnostics;
  readonly clock: DatabaseClock;
  readonly #connection: Database;
  readonly #closeConnection: (connection: Database) => void;
  readonly #checkpointWal: (
    connection: Database,
    signal?: AbortSignal,
  ) => WalCheckpointResult;
  readonly #releaseOwnership: (dataDirectory: string, owner: symbol) => void;
  readonly #dataDirectory: string;
  readonly #owner: symbol;
  readonly #executeTransactionControl: DatabaseProviderDependencies['executeTransactionControl'];
  readonly #sleep: DatabaseProviderDependencies['sleep'];
  readonly #random: DatabaseProviderDependencies['random'];
  #state: ProviderState = 'open';
  #closePromise?: Promise<void>;
  #checkpointSignal?: AbortSignal;
  #transactionActive = false;
  #activeOperations = 0;
  #resolveOperationsDrained?: () => void;
  #lastCheckpointResult: WalCheckpointResult | undefined;

  constructor(
    connection: Database,
    accessMode: DatabaseAccessMode,
    diagnostics: SqliteDiagnostics,
    clock: DatabaseClock,
    closeConnection: (connection: Database) => void,
    checkpoint: (connection: Database) => WalCheckpointResult,
    releaseProviderOwnership: (dataDirectory: string, owner: symbol) => void,
    dataDirectory: string,
    owner: symbol,
    executeTransactionControl: DatabaseProviderDependencies['executeTransactionControl'],
    sleep: DatabaseProviderDependencies['sleep'],
    random: DatabaseProviderDependencies['random'],
  ) {
    this.#connection = connection;
    this.accessMode = accessMode;
    this.diagnostics = diagnostics;
    this.clock = clock;
    this.#closeConnection = closeConnection;
    this.#checkpointWal = checkpoint;
    this.#releaseOwnership = releaseProviderOwnership;
    this.#dataDirectory = dataDirectory;
    this.#owner = owner;
    this.#executeTransactionControl = executeTransactionControl;
    this.#sleep = sleep;
    this.#random = random;
  }

  get lastCheckpointResult(): WalCheckpointResult | undefined {
    return this.#lastCheckpointResult;
  }

  read<T>(operation: (connection: DatabaseConnection) => T): T {
    this.#acquireOperation();
    let facade: DatabaseConnection | undefined;
    try {
      facade = createDatabaseConnectionFacade(this.#connection);
      return operation(facade);
    } finally {
      if (facade !== undefined) revokeDatabaseConnectionFacade(facade);
      this.#releaseOperation();
    }
  }

  transaction<T>(
    operation: (
      transaction: TransactionContext,
    ) => SynchronousTransactionResult<T>,
    options: TransactionOptions = {},
  ): Promise<T> {
    this.#assertOpen();
    if (this.accessMode === 'read-only') throw new DatabaseReadOnlyError();
    if (this.#transactionActive) throw new NestedTransactionError();
    const retry = validateRetryOptions(options.retry);
    this.#acquireOperation();
    this.#transactionActive = true;
    try {
      const started = this.#startTransaction(operation, retry);
      if (started.kind === 'retrying') {
        return started.promise.finally(() => this.#finishTransaction());
      }
      this.#finishTransaction();
      return Promise.resolve(started.value);
    } catch (error) {
      this.#finishTransaction();
      return Promise.reject(error);
    }
  }

  #startTransaction<T>(
    operation: (
      transaction: TransactionContext,
    ) => SynchronousTransactionResult<T>,
    retry: TransactionRetryOptions | undefined,
  ):
    | { readonly kind: 'completed'; readonly value: T }
    | { readonly kind: 'retrying'; readonly promise: Promise<T> } {
    try {
      return {
        kind: 'completed',
        value: this.#runTransactionAttempt(operation),
      };
    } catch (error) {
      if (!(error instanceof BeginTransactionBusyError)) throw error;
      if (!retry) throw error.sqliteError;
      const maximumAttempts = retry.maxRetries + 1;
      if (maximumAttempts === 1) {
        throw new DatabaseBusyRetryExhaustedError(1, error.sqliteError);
      }
      return {
        kind: 'retrying',
        promise: this.#continueTransactionWithRetry(
          operation,
          retry,
          maximumAttempts,
        ),
      };
    }
  }

  async #continueTransactionWithRetry<T>(
    operation: (
      transaction: TransactionContext,
    ) => SynchronousTransactionResult<T>,
    retry: TransactionRetryOptions,
    maximumAttempts: number,
  ): Promise<T> {
    for (let attempt = 2; attempt <= maximumAttempts; attempt += 1) {
      this.#assertOpen();
      await this.#sleep(computeRetryDelay(retry, attempt - 1, this.#random));
      this.#assertOpen();
      try {
        return this.#runTransactionAttempt(operation);
      } catch (error) {
        if (!(error instanceof BeginTransactionBusyError)) throw error;
        if (attempt === maximumAttempts) {
          throw new DatabaseBusyRetryExhaustedError(attempt, error.sqliteError);
        }
      }
    }
    throw new Error('Unreachable database transaction retry state');
  }

  #finishTransaction(): void {
    this.#transactionActive = false;
    this.#releaseOperation();
  }

  #runTransactionAttempt<T>(
    operation: (
      transaction: TransactionContext,
    ) => SynchronousTransactionResult<T>,
  ): T {
    const database = createDatabaseConnectionFacade(this.#connection, 'write');
    let transactionStarted = false;
    try {
      try {
        this.#executeTransactionControl(this.#connection, 'BEGIN IMMEDIATE');
      } catch (error) {
        if (isBusyError(error)) throw new BeginTransactionBusyError(error);
        throw error;
      }
      transactionStarted = true;
      const now = this.clock.now(database);
      const result = operation(
        Object.freeze({ database, clock: this.clock, now }),
      );
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

  close(options: DatabaseProviderCloseOptions = {}): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#checkpointSignal = options.checkpointSignal;
    this.#state = 'closing';
    this.#closePromise = Promise.resolve().then(() => this.#finishClose());
    return this.#closePromise;
  }

  async #finishClose(): Promise<void> {
    await this.#waitForOperationsToDrain();
    const errors: unknown[] = [];
    if (this.accessMode === 'read-write') {
      try {
        this.#lastCheckpointResult = this.#checkpointWal(
          this.#connection,
          this.#checkpointSignal,
        );
      } catch (error) {
        errors.push(error);
      }
    }

    let connectionClosed = false;
    try {
      this.#closeConnection(this.#connection);
      connectionClosed = true;
    } catch (error) {
      errors.push(error);
    }

    if (connectionClosed) {
      try {
        this.#releaseOwnership(this.#dataDirectory, this.#owner);
      } catch (error) {
        errors.push(error);
      }
    }
    this.#state = 'closed';
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new AggregateError(errors, 'Database provider close failed');
    }
  }

  #acquireOperation(): void {
    this.#assertOpen();
    this.#activeOperations += 1;
  }

  #releaseOperation(): void {
    this.#activeOperations -= 1;
    if (this.#activeOperations === 0) {
      const resolveDrained = this.#resolveOperationsDrained;
      this.#resolveOperationsDrained = undefined;
      resolveDrained?.();
    }
  }

  #waitForOperationsToDrain(): Promise<void> {
    if (this.#activeOperations === 0) return Promise.resolve();
    return new Promise((resolve) => {
      this.#resolveOperationsDrained = resolve;
    });
  }

  #assertOpen(): void {
    if (this.#state !== 'open') throw new DatabaseProviderClosedError();
  }
}

const defaultDependencies: DatabaseProviderDependencies = {
  connectionFactory: (databasePath, accessMode) =>
    accessMode === 'read-only'
      ? new Database(databasePath, { readonly: true, create: false })
      : new Database(databasePath, { create: true }),
  configureConnection: configureSqliteConnection,
  createDiagnostics: createSqliteDiagnostics,
  createClock: () => new SqliteDatabaseClock(),
  closeConnection: (connection) => connection.close(),
  checkpointWal,
  releaseOwnership,
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
  validateRetryBudget(retry);
  return Object.freeze({ ...retry });
}

const SQLITE_BUSY_TIMEOUT_MS = 250;
const MAX_TRANSACTION_RETRY_BUDGET_MS = 2_000;
const MAX_TRANSACTION_RETRIES =
  MAX_TRANSACTION_RETRY_BUDGET_MS / SQLITE_BUSY_TIMEOUT_MS - 1;

function validateRetryBudget(retry: TransactionRetryOptions): void {
  if (retry.maxRetries > MAX_TRANSACTION_RETRIES) {
    throw new RangeError('Database transaction retry budget exceeds 2000ms');
  }
  let remainingBudget =
    MAX_TRANSACTION_RETRY_BUDGET_MS -
    (retry.maxRetries + 1) * SQLITE_BUSY_TIMEOUT_MS;

  for (let retryNumber = 1; retryNumber <= retry.maxRetries; retryNumber += 1) {
    const factor = 2 ** (retryNumber - 1);
    const exponential =
      retry.baseDelayMs > Math.floor(retry.maxDelayMs / factor)
        ? retry.maxDelayMs
        : retry.baseDelayMs * factor;
    if (exponential > remainingBudget) {
      throw new RangeError('Database transaction retry budget exceeds 2000ms');
    }
    const maximumDelay = Math.min(
      retry.maxDelayMs,
      Math.round(exponential * (1 + retry.jitterRatio)),
    );
    if (maximumDelay > remainingBudget) {
      throw new RangeError('Database transaction retry budget exceeds 2000ms');
    }
    remainingBudget -= maximumDelay;
  }
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

type DatabaseFileIdentity = Readonly<{ dev: number; ino: number }>;

function inspectDatabaseFileIdentity(
  databasePath: string,
): DatabaseFileIdentity | undefined {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(databasePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new DatabaseProviderPathError('database_open_failed');
  }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) {
    throw new DatabaseProviderPathError('database_open_failed');
  }
  try {
    if (realpathSync.native(databasePath) !== databasePath) {
      throw new DatabaseProviderPathError('database_open_failed');
    }
  } catch (error) {
    if (error instanceof DatabaseProviderPathError) throw error;
    throw new DatabaseProviderPathError('database_open_failed');
  }
  return Object.freeze({ dev: stat.dev, ino: stat.ino });
}

function createProvider(
  databasePath: string,
  accessMode: DatabaseAccessMode,
  overrides: DatabaseProviderDependencyOverrides = {},
): DatabaseProvider {
  const normalizedPath = resolve(databasePath);
  const requestedDataDirectory = dirname(normalizedPath);
  let dataDirectory: string;
  try {
    if (accessMode === 'read-write') {
      mkdirSync(requestedDataDirectory, { recursive: true });
    }
    dataDirectory = realpathSync.native(requestedDataDirectory);
  } catch {
    throw new DatabaseProviderPathError('directory_unavailable');
  }
  const canonicalDatabasePath = join(dataDirectory, basename(normalizedPath));
  const identityBeforeOpen = inspectDatabaseFileIdentity(canonicalDatabasePath);
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
    try {
      connection = dependencies.connectionFactory(
        canonicalDatabasePath,
        accessMode,
      );
      const identityAfterOpen = inspectDatabaseFileIdentity(
        canonicalDatabasePath,
      );
      if (
        identityAfterOpen !== undefined &&
        identityBeforeOpen !== undefined &&
        (identityAfterOpen.dev !== identityBeforeOpen.dev ||
          identityAfterOpen.ino !== identityBeforeOpen.ino)
      ) {
        throw new DatabaseProviderPathError('database_open_failed');
      }
    } catch {
      throw new DatabaseProviderPathError('database_open_failed');
    }
    const role =
      accessMode === 'read-only' ? 'business-read-only' : 'business-read-write';
    const configuration = dependencies.configureConnection(connection, role);
    const diagnostics = dependencies.createDiagnostics(
      connection,
      configuration,
    );
    const clock = dependencies.clock ?? dependencies.createClock();
    return new SqliteDatabaseProvider(
      connection,
      accessMode,
      diagnostics,
      clock,
      dependencies.closeConnection,
      dependencies.checkpointWal,
      dependencies.releaseOwnership,
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
  options: DatabaseProviderOptions = {},
): DatabaseProvider {
  const accessMode = validateAccessMode(options.accessMode);
  return createProvider(databasePath, accessMode);
}

export function createDatabaseProviderWithDependencies(
  databasePath: string,
  options: DatabaseProviderOptions,
  overrides: DatabaseProviderDependencyOverrides,
): DatabaseProvider {
  return createProvider(
    databasePath,
    validateAccessMode(options.accessMode),
    overrides,
  );
}

function validateAccessMode(
  accessMode: DatabaseAccessMode | undefined,
): DatabaseAccessMode {
  if (accessMode === undefined) return 'read-write';
  if (accessMode === 'read-write' || accessMode === 'read-only') {
    return accessMode;
  }
  throw new TypeError('Invalid database access mode');
}
