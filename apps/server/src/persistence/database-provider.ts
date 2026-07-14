import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Database } from 'bun:sqlite';
import {
  DatabaseFacadeRevokedError,
  SqliteDatabaseClock,
  createDatabaseConnectionFacade,
  revokeDatabaseConnectionFacade,
  type DatabaseClock,
  type DatabaseConnection,
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

export interface DatabaseProvider {
  readonly dialect: 'sqlite';
  readonly clock: DatabaseClock;

  read<T>(operation: (connection: DatabaseConnection) => T): T;
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
}

export interface TestDatabaseProviderOptions {
  readonly clock?: DatabaseClock;
  readonly connectionFactory?: (databasePath: string) => Database;
  readonly configureConnection?: (connection: Database) => void;
  readonly initializeSchema?: (connection: Database) => void;
  readonly createClock?: () => DatabaseClock;
  readonly closeConnection?: (connection: Database) => void;
}

const dataDirectoryOwners = new Map<string, symbol>();

class SqliteDatabaseProvider implements DatabaseProvider {
  readonly dialect = 'sqlite' as const;
  readonly clock: DatabaseClock;
  readonly #connection: Database;
  readonly #closeConnection: (connection: Database) => void;
  readonly #dataDirectory: string;
  readonly #owner: symbol;
  #state: ProviderState = 'open';
  #closePromise?: Promise<void>;

  constructor(
    connection: Database,
    clock: DatabaseClock,
    closeConnection: (connection: Database) => void,
    dataDirectory: string,
    owner: symbol,
  ) {
    this.#connection = connection;
    this.clock = clock;
    this.#closeConnection = closeConnection;
    this.#dataDirectory = dataDirectory;
    this.#owner = owner;
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

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#state = 'closing';
    this.#closePromise = (async () => {
      try {
        this.#closeConnection(this.#connection);
      } finally {
        releaseOwnership(this.#dataDirectory, this.#owner);
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
};

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
  const dataDirectory = dirname(normalizedPath);
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
    mkdirSync(dataDirectory, { recursive: true });
    connection = dependencies.connectionFactory(normalizedPath);
    dependencies.configureConnection(connection);
    dependencies.initializeSchema(connection);
    const clock = dependencies.clock ?? dependencies.createClock();
    return new SqliteDatabaseProvider(
      connection,
      clock,
      dependencies.closeConnection,
      dataDirectory,
      owner,
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
    releaseOwnership(dataDirectory, owner);
    if (closeError !== undefined) {
      throw new AggregateError(
        [initializationError, closeError],
        'Database provider initialization and cleanup failed',
      );
    }
    throw initializationError;
  }
}

export function createDatabaseProvider(databasePath: string): DatabaseProvider {
  return createProvider(databasePath);
}

export function createTestDatabaseProvider(
  databasePath: string,
  options: TestDatabaseProviderOptions = {},
): DatabaseProvider {
  return createProvider(databasePath, options);
}
