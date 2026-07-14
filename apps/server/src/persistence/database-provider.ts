export {
  AsyncTransactionCallbackError,
  DatabaseBusyRetryExhaustedError,
  DatabaseFacadeRevokedError,
  DatabaseProviderClosedError,
  DatabaseReadOnlyError,
  DatabaseProviderOwnershipError,
  DatabaseProviderPathError,
  NestedTransactionError,
  type DatabaseClock,
  type DatabaseAccessMode,
  type DatabaseConnection,
  type DatabaseProvider,
  type DatabaseProviderCloseOptions,
  type DatabaseProviderOptions,
  type DatabaseProviderPathErrorCode,
  type SynchronousTransactionResult,
  type TransactionContext,
  type TransactionOptions,
  type TransactionRetryOptions,
} from './database-provider-internal';
export type { WalCheckpointResult } from './sqlite-checkpoint';
export type { SqliteDiagnostics } from './sqlite-diagnostics';
import {
  createInternalDatabaseProvider,
  type DatabaseProvider,
  type DatabaseProviderOptions,
} from './database-provider-internal';

export function createDatabaseProvider(
  databasePath: string,
  options: DatabaseProviderOptions = {},
): DatabaseProvider {
  return createInternalDatabaseProvider(databasePath, options);
}
