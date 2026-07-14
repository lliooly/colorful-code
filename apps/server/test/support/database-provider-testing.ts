import {
  createDatabaseProviderWithDependencies,
  type DatabaseAccessMode,
  type DatabaseProvider,
  type DatabaseProviderDependencyOverrides,
} from '../../src/persistence/database-provider-internal';

export interface TestDatabaseProviderOptions extends DatabaseProviderDependencyOverrides {
  readonly accessMode?: DatabaseAccessMode;
}

export function createTestDatabaseProvider(
  databasePath: string,
  options: TestDatabaseProviderOptions = {},
): DatabaseProvider {
  const { accessMode, ...dependencies } = options;
  return createDatabaseProviderWithDependencies(
    databasePath,
    { accessMode },
    dependencies,
  );
}
