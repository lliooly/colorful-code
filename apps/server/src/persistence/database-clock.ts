import type { Database } from 'bun:sqlite';
import {
  createDrizzleDatabase,
  type PersistenceDrizzleDatabase,
} from './database';

const CLOCK_QUERY = `
  SELECT CAST(strftime('%s', 'now') AS INTEGER) * 1000
       + CAST(substr(strftime('%f', 'now'), 4, 3) AS INTEGER) AS now_ms
`;

const READ_DATABASE_PROPERTIES = new Set<PropertyKey>([
  'select',
  'selectDistinct',
]);
const WRITE_DATABASE_PROPERTIES = new Set<PropertyKey>([
  ...READ_DATABASE_PROPERTIES,
  'delete',
  'insert',
  'update',
]);
const HIDDEN_SCOPED_PROPERTIES = new Set<PropertyKey>([
  '$client',
  'client',
  'raw',
  'session',
  'stmt',
]);
const TERMINAL_QUERY_METHODS = new Set<PropertyKey>([
  'all',
  'execute',
  'get',
  'run',
  'values',
]);

export class DatabaseFacadeRevokedError extends Error {
  constructor() {
    super('The database facade is no longer active');
    this.name = 'DatabaseFacadeRevokedError';
  }
}

export type ReadDatabase = Pick<
  PersistenceDrizzleDatabase,
  'select' | 'selectDistinct'
>;
export type WriteDatabase = Pick<
  PersistenceDrizzleDatabase,
  'delete' | 'insert' | 'select' | 'selectDistinct' | 'update'
>;

export interface DatabaseConnection {
  readonly db: ReadDatabase;
}

export interface WriteDatabaseConnection extends DatabaseConnection {
  readonly db: WriteDatabase;
}

export interface DatabaseClock {
  now(connection: DatabaseConnection): number;
}

interface ConnectionState {
  active: boolean;
  readonly raw: Database;
  readonly database: ReadDatabase;
  readonly scopedValues: WeakMap<object, object>;
}

const connectionStates = new WeakMap<DatabaseConnection, ConnectionState>();

function assertActive(state: ConnectionState | undefined): ConnectionState {
  if (!state?.active) throw new DatabaseFacadeRevokedError();
  return state;
}

/** @internal Creates the capability passed only for the duration of an operation. */
export function createDatabaseConnectionFacade(
  raw: Database,
  access: 'write',
): WriteDatabaseConnection;
export function createDatabaseConnectionFacade(
  raw: Database,
  access?: 'read',
): DatabaseConnection;
export function createDatabaseConnectionFacade(
  raw: Database,
  access: 'read' | 'write' = 'read',
): DatabaseConnection | WriteDatabaseConnection {
  const state = {} as ConnectionState;
  const drizzleDatabase = createDrizzleDatabase(raw);
  const scopedValues = new WeakMap<object, object>();
  const databaseProperties =
    access === 'write' ? WRITE_DATABASE_PROPERTIES : READ_DATABASE_PROPERTIES;

  const scopeValue = <T>(value: T, terminal = false): T => {
    if (
      terminal ||
      ((typeof value !== 'object' || value === null) &&
        typeof value !== 'function')
    ) {
      return value;
    }
    const object = value as object;
    const existing = scopedValues.get(object);
    if (existing) return existing as T;

    const scoped = new Proxy(object, {
      get(target, property) {
        assertActive(state);
        if (HIDDEN_SCOPED_PROPERTIES.has(property)) return undefined;
        const nested = Reflect.get(target, property, target);
        if (typeof nested !== 'function') return scopeValue(nested);
        return (...arguments_: unknown[]) => {
          assertActive(state);
          const result = Reflect.apply(nested, target, arguments_);
          return scopeValue(result, TERMINAL_QUERY_METHODS.has(property));
        };
      },
      getOwnPropertyDescriptor(target, property) {
        assertActive(state);
        if (HIDDEN_SCOPED_PROPERTIES.has(property)) return undefined;
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
      getPrototypeOf() {
        assertActive(state);
        return null;
      },
      set() {
        assertActive(state);
        return false;
      },
      defineProperty() {
        assertActive(state);
        return false;
      },
      deleteProperty() {
        assertActive(state);
        return false;
      },
      setPrototypeOf() {
        assertActive(state);
        return false;
      },
      has(target, property) {
        assertActive(state);
        return (
          !HIDDEN_SCOPED_PROPERTIES.has(property) &&
          Reflect.has(target, property)
        );
      },
      ownKeys(target) {
        assertActive(state);
        return Reflect.ownKeys(target).filter(
          (property) => !HIDDEN_SCOPED_PROPERTIES.has(property),
        );
      },
    });
    scopedValues.set(object, scoped);
    return scoped as T;
  };

  const database = new Proxy(drizzleDatabase, {
    get(target, property) {
      assertActive(state);
      if (!databaseProperties.has(property)) return undefined;
      const value = Reflect.get(target, property, target);
      if (typeof value !== 'function') return scopeValue(value);
      return (...arguments_: unknown[]) => {
        assertActive(state);
        return scopeValue(Reflect.apply(value, target, arguments_));
      };
    },
    getOwnPropertyDescriptor(target, property) {
      assertActive(state);
      if (!databaseProperties.has(property)) return undefined;
      return Reflect.getOwnPropertyDescriptor(target, property);
    },
    getPrototypeOf() {
      assertActive(state);
      return null;
    },
    set() {
      assertActive(state);
      return false;
    },
    defineProperty() {
      assertActive(state);
      return false;
    },
    deleteProperty() {
      assertActive(state);
      return false;
    },
    setPrototypeOf() {
      assertActive(state);
      return false;
    },
    has(target, property) {
      assertActive(state);
      return databaseProperties.has(property) && Reflect.has(target, property);
    },
    ownKeys(target) {
      assertActive(state);
      return Reflect.ownKeys(target).filter((property) =>
        databaseProperties.has(property),
      );
    },
  }) as ReadDatabase;

  Object.assign(state, { active: true, raw, database, scopedValues });
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
