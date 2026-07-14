export {
  AsyncTransactionCallbackError,
  DatabaseBusyRetryExhaustedError,
  DatabaseFacadeRevokedError,
  DatabaseProviderClosedError,
  DatabaseProviderOwnershipError,
  NestedTransactionError,
  type DatabaseClock,
  type DatabaseConnection,
  type DatabaseProvider,
  type SynchronousTransactionResult,
  type TransactionContext,
  type TransactionOptions,
  type TransactionRetryOptions,
} from './database-provider-internal';
import {
  createInternalDatabaseProvider,
  type DatabaseProvider,
} from './database-provider-internal';

export function createDatabaseProvider(databasePath: string): DatabaseProvider {
  return createInternalDatabaseProvider(databasePath);
}
