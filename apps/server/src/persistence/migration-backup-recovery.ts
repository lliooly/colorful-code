import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Database } from 'bun:sqlite';

export interface MigrationBackupManifest {
  readonly formatVersion: 1;
  readonly sourceDatabasePath: string;
  readonly sourceSchemaVersion: number;
  readonly targetSchemaVersion: number;
  readonly createdAt: string;
  readonly databaseFile: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly integrityCheck: 'ok';
  readonly foreignKeyViolations: 0;
}

export interface MigrationBackup {
  readonly directoryPath: string;
  readonly databasePath: string;
  readonly manifestPath: string;
  readonly manifest: MigrationBackupManifest;
}

function sqliteString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function compactUtcTimestamp(date: Date): string {
  return date.toISOString().replace(/[-:.]/g, '');
}

function assertSchemaVersion(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
}

function assertValidDate(value: Date): void {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError('now must return a valid Date');
  }
}

function assertSafePathSegment(value: string): void {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value === '.' ||
    value === '..' ||
    /[\\/\0]/.test(value)
  ) {
    throw new TypeError('randomId must return a safe single path segment');
  }
}

function resolveSourceDatabasePath(
  database: Database,
  sourceDatabasePath: string,
): string {
  if (
    database.filename.length === 0 ||
    database.filename === ':memory:' ||
    database.filename.startsWith('file:') ||
    sourceDatabasePath.length === 0 ||
    sourceDatabasePath === ':memory:' ||
    sourceDatabasePath.startsWith('file:')
  ) {
    throw new TypeError('Migration backups require a named file database');
  }

  const actualDatabasePath = resolve(database.filename);
  const claimedDatabasePath = resolve(sourceDatabasePath);
  if (actualDatabasePath !== claimedDatabasePath) {
    throw new Error(
      `sourceDatabasePath does not match the database connection: ${claimedDatabasePath}`,
    );
  }
  return claimedDatabasePath;
}

export function verifyDatabase(databasePath: string): void {
  const database = new Database(databasePath, { readonly: true });
  try {
    const integrityResults = database
      .query<{ integrity_check: string }, []>('PRAGMA integrity_check')
      .all();
    if (
      integrityResults.length !== 1 ||
      integrityResults[0]?.integrity_check !== 'ok'
    ) {
      throw new Error('Database integrity_check failed');
    }

    if (database.query('PRAGMA foreign_key_check').all().length !== 0) {
      throw new Error('Database foreign_key_check failed');
    }
  } finally {
    database.close();
  }
}

export function createMigrationBackup(options: {
  database: Database;
  sourceDatabasePath: string;
  sourceSchemaVersion: number;
  targetSchemaVersion: number;
  now?: () => Date;
  randomId?: () => string;
}): MigrationBackup {
  assertSchemaVersion('sourceSchemaVersion', options.sourceSchemaVersion);
  assertSchemaVersion('targetSchemaVersion', options.targetSchemaVersion);
  const sourceDatabasePath = resolveSourceDatabasePath(
    options.database,
    options.sourceDatabasePath,
  );
  const createdAt = (options.now ?? (() => new Date()))();
  assertValidDate(createdAt);
  const randomId = (options.randomId ?? randomUUID)();
  assertSafePathSegment(randomId);
  const id = `${compactUtcTimestamp(createdAt)}-${randomId}`;
  const backupsPath = join(dirname(sourceDatabasePath), 'backups');
  const directoryPath = join(backupsPath, id);
  const temporaryDirectoryPath = join(backupsPath, `.${id}.tmp`);
  const reservationPath = join(backupsPath, `.${id}.reserve`);
  const databaseFile = 'colorful-code.db';
  const temporaryDatabasePath = join(temporaryDirectoryPath, databaseFile);
  const temporaryManifestPath = join(temporaryDirectoryPath, 'manifest.json');

  mkdirSync(backupsPath, { recursive: true });
  let reservation: number;
  try {
    reservation = openSync(reservationPath, 'wx');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`Backup reservation already exists: ${reservationPath}`);
    }
    throw error;
  }

  try {
    if (existsSync(directoryPath) || existsSync(temporaryDirectoryPath)) {
      throw new Error(`Refusing to overwrite backup ${directoryPath}`);
    }

    mkdirSync(temporaryDirectoryPath);
    try {
      options.database.exec(
        `VACUUM INTO ${sqliteString(temporaryDatabasePath)}`,
      );
      verifyDatabase(temporaryDatabasePath);

      const databaseBytes = readFileSync(temporaryDatabasePath);
      const manifest: MigrationBackupManifest = {
        formatVersion: 1,
        sourceDatabasePath,
        sourceSchemaVersion: options.sourceSchemaVersion,
        targetSchemaVersion: options.targetSchemaVersion,
        createdAt: createdAt.toISOString(),
        databaseFile,
        sizeBytes: statSync(temporaryDatabasePath).size,
        sha256: createHash('sha256').update(databaseBytes).digest('hex'),
        integrityCheck: 'ok',
        foreignKeyViolations: 0,
      };
      writeFileSync(
        temporaryManifestPath,
        `${JSON.stringify(manifest, null, 2)}\n`,
        {
          encoding: 'utf8',
          flag: 'wx',
        },
      );
      renameSync(temporaryDirectoryPath, directoryPath);

      return {
        directoryPath,
        databasePath: join(directoryPath, databaseFile),
        manifestPath: join(directoryPath, 'manifest.json'),
        manifest,
      };
    } catch (error) {
      rmSync(temporaryDirectoryPath, { recursive: true, force: true });
      throw error;
    }
  } finally {
    try {
      closeSync(reservation);
    } finally {
      rmSync(reservationPath, { force: true });
    }
  }
}
