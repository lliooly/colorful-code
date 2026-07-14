import { mkdir } from 'node:fs/promises';
import { Database } from 'bun:sqlite';
import { resolveDatabasePath } from './database-path';
import { runMigrations, type Migration } from './migration-framework';

export const MIGRATIONS: readonly Migration[] = Object.freeze([]);

export interface MigrationBootstrapDatabase {
  close(force?: boolean): void | Promise<void>;
}

export interface BootstrapMigrationOptions {
  migrations?: readonly Migration[];
  mkdir?: (
    path: string,
    options: { recursive: true },
  ) => void | Promise<unknown>;
  openDatabase?: (
    databasePath: string,
    options: { create: true; readwrite: true },
  ) => MigrationBootstrapDatabase;
  runMigrations?: (
    database: MigrationBootstrapDatabase,
    migrations: readonly Migration[],
  ) => unknown;
}

export async function bootstrapMigrations(
  databasePath: string,
  options: BootstrapMigrationOptions = {},
): Promise<void> {
  const resolvedPath = await resolveDatabasePath(databasePath);
  await (options.mkdir ?? mkdir)(resolvedPath.dataDirectory, {
    recursive: true,
  });

  const openDatabase =
    options.openDatabase ??
    ((path: string, databaseOptions: { create: true; readwrite: true }) =>
      new Database(path, databaseOptions));
  const migrate =
    options.runMigrations ??
    ((database: MigrationBootstrapDatabase, migrations: readonly Migration[]) =>
      runMigrations(database as Database, migrations));
  const database = openDatabase(resolvedPath.databasePath, {
    create: true,
    readwrite: true,
  });

  let migrationFailed = false;
  let migrationError: unknown;
  try {
    await migrate(database, options.migrations ?? MIGRATIONS);
  } catch (error) {
    migrationFailed = true;
    migrationError = error;
  }

  try {
    await database.close(true);
  } catch (closeError) {
    if (migrationFailed) {
      throw new AggregateError(
        [migrationError, closeError],
        'Database migration and close failed',
      );
    }
    throw closeError;
  }

  if (migrationFailed) throw migrationError;
}
