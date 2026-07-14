import { lstat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

export type DatabasePathErrorCode =
  | 'in_memory_database_unsupported'
  | 'unsupported_file_uri'
  | 'symbolic_link_database';

export class DatabasePathError extends Error {
  readonly code: DatabasePathErrorCode;

  constructor(code: DatabasePathErrorCode, message: string) {
    super(message);
    this.name = 'DatabasePathError';
    this.code = code;
  }
}

export interface ResolvedDatabasePath {
  kind: 'file';
  databasePath: string;
  dataDirectory: string;
}

const MEMORY_FILE_URI = /^file::memory:(?:\?.*)?$/u;

export async function resolveDatabasePath(
  databasePath: string,
): Promise<ResolvedDatabasePath> {
  if (
    databasePath === '' ||
    databasePath === ':memory:' ||
    MEMORY_FILE_URI.test(databasePath)
  ) {
    throw new DatabasePathError(
      'in_memory_database_unsupported',
      'In-memory SQLite databases are unsupported during daemon bootstrap: the short-lived migration connection cannot hand the database off to the business application. Use a persistent file database until a DatabaseProvider or Test Database Factory provides connection handoff.',
    );
  }

  if (/^file:/iu.test(databasePath)) {
    throw new DatabasePathError(
      'unsupported_file_uri',
      'SQLite file URIs are unsupported during daemon bootstrap',
    );
  }

  const resolvedPath = resolve(databasePath);
  try {
    const metadata = await lstat(resolvedPath);
    if (metadata.isSymbolicLink()) {
      throw new DatabasePathError(
        'symbolic_link_database',
        'SQLite database path must not be a symbolic link',
      );
    }
  } catch (error) {
    if (error instanceof DatabasePathError) throw error;
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  // The resolved path is handed unchanged to migration and business startup.
  // Bun does not expose SQLITE_OPEN_NOFOLLOW, so rejecting an existing final
  // symlink narrows aliases but does not eliminate the lstat-to-open race if the
  // path is created or replaced before either database connection is opened.
  return {
    kind: 'file',
    databasePath: resolvedPath,
    dataDirectory: dirname(resolvedPath),
  };
}
