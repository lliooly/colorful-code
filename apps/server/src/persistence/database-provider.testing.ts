/**
 * Test-only fault-injection adapter. Production modules must import
 * `database-provider.ts`; the database access boundary test enforces that this
 * module is imported only from `apps/server/test`.
 */
export { type TestDatabaseProviderOptions } from './database-provider-internal';
import {
  createInternalTestDatabaseProvider,
  type DatabaseProvider,
  type TestDatabaseProviderOptions,
} from './database-provider-internal';

export function createTestDatabaseProvider(
  databasePath: string,
  options: TestDatabaseProviderOptions = {},
): DatabaseProvider {
  return createInternalTestDatabaseProvider(databasePath, options);
}
