import type { Database } from 'bun:sqlite';
import {
  createDrizzleDatabase,
  type PersistenceDrizzleDatabase,
} from './database';

const CLOCK_QUERY = `
  SELECT CAST(strftime('%s', 'now') AS INTEGER) * 1000
       + CAST(substr(strftime('%f', 'now'), 4, 3) AS INTEGER) AS now_ms
`;

const HIDDEN_DATABASE_PROPERTIES = new Set<PropertyKey>(['$client', 'session']);

export class DatabaseFacadeRevokedError extends Error {
  constructor() {
    super('The database facade is no longer active');
    this.name = 'DatabaseFacadeRevokedError';
  }
}

export type ReadDatabase = Omit<
  PersistenceDrizzleDatabase,
  '$client' | 'session'
>;

export interface DatabaseConnection {
  readonly db: ReadDatabase;
}

export interface DatabaseClock {
  now(connection: DatabaseConnection): number;
}

interface ConnectionState {
  active: boolean;
  readonly raw: Database;
  readonly database: ReadDatabase;
}

const connectionStates = new WeakMap<DatabaseConnection, ConnectionState>();

function assertActive(state: ConnectionState | undefined): ConnectionState {
  if (!state?.active) throw new DatabaseFacadeRevokedError();
  return state;
}

/** @internal Creates the capability passed only for the duration of an operation. */
export function createDatabaseConnectionFacade(
  raw: Database,
): DatabaseConnection {
  const state = {} as ConnectionState;
  const drizzleDatabase = createDrizzleDatabase(raw);
  const database = new Proxy(drizzleDatabase, {
    get(target, property) {
      assertActive(state);
      if (HIDDEN_DATABASE_PROPERTIES.has(property)) return undefined;
      const value = Reflect.get(target, property, target);
      if (typeof value !== 'function') return value;
      return (...arguments_: unknown[]) => {
        assertActive(state);
        return Reflect.apply(value, target, arguments_);
      };
    },
    getOwnPropertyDescriptor(target, property) {
      assertActive(state);
      if (HIDDEN_DATABASE_PROPERTIES.has(property)) return undefined;
      return Reflect.getOwnPropertyDescriptor(target, property);
    },
    has(target, property) {
      assertActive(state);
      return (
        !HIDDEN_DATABASE_PROPERTIES.has(property) &&
        Reflect.has(target, property)
      );
    },
    ownKeys(target) {
      assertActive(state);
      return Reflect.ownKeys(target).filter(
        (property) => !HIDDEN_DATABASE_PROPERTIES.has(property),
      );
    },
  }) as ReadDatabase;

  Object.assign(state, { active: true, raw, database });
  const connection = Object.freeze({
    get db(): ReadDatabase {
      return assertActive(connectionStates.get(connection)).database;
    },
  });
  connectionStates.set(connection, state);
  return connection;
}

/** @internal Invalidates a callback-scoped database capability. */
export function revokeDatabaseConnectionFacade(
  connection: DatabaseConnection,
): void {
  const state = connectionStates.get(connection);
  if (state) state.active = false;
}

function rawConnection(connection: DatabaseConnection): Database {
  return assertActive(connectionStates.get(connection)).raw;
}

export class SqliteDatabaseClock implements DatabaseClock {
  now(connection: DatabaseConnection): number {
    const row = rawConnection(connection)
      .query<{ now_ms: number }, []>(CLOCK_QUERY)
      .get();
    const value = row?.now_ms;
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
      throw new RangeError(
        'SQLite clock did not return a safe Unix millisecond integer',
      );
    }
    return value;
  }
}

export class FixedDatabaseClock implements DatabaseClock {
  readonly #value: number;

  constructor(value: number) {
    if (!Number.isSafeInteger(value)) {
      throw new RangeError('Fixed database clock requires a safe integer');
    }
    this.#value = value;
  }

  now(connection: DatabaseConnection): number {
    assertActive(connectionStates.get(connection));
    return this.#value;
  }
}
