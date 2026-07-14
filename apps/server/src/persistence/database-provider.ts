export {
  DatabaseFacadeRevokedError,
  DatabaseProviderClosedError,
  DatabaseProviderOwnershipError,
  type DatabaseClock,
  type DatabaseConnection,
  type DatabaseProvider,
} from './database-provider-internal';
import {
  createInternalDatabaseProvider,
  type DatabaseProvider,
} from './database-provider-internal';

export function createDatabaseProvider(databasePath: string): DatabaseProvider {
  return createInternalDatabaseProvider(databasePath);
}
