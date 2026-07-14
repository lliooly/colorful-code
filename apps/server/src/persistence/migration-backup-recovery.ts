import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { Database } from 'bun:sqlite';

export interface MigrationBackupManifest {
  formatVersion: 1;
  sourceDatabasePath: string;
  sourceSchemaVersion: number;
  targetSchemaVersion: number;
  createdAt: string;
  databaseFile: string;
  sizeBytes: number;
  sha256: string;
  integrityCheck: 'ok';
  foreignKeyViolations: 0;
}

export interface MigrationBackup {
  directoryPath: string;
  databasePath: string;
  manifestPath: string;
  manifest: MigrationBackupManifest;
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
  const sourceDatabasePath = resolve(options.sourceDatabasePath);
  const createdAt = (options.now ?? (() => new Date()))();
  assertValidDate(createdAt);
  const randomId = (options.randomId ?? randomUUID)();
  assertSafePathSegment(randomId);
  const id = `${compactUtcTimestamp(createdAt)}-${randomId}`;
  const backupsPath = join(dirname(sourceDatabasePath), 'backups');
  const directoryPath = join(backupsPath, id);
  const temporaryDirectoryPath = join(backupsPath, `.${id}.tmp`);
  const databaseFile = basename(sourceDatabasePath);
  const temporaryDatabasePath = join(temporaryDirectoryPath, databaseFile);
  const temporaryManifestPath = join(temporaryDirectoryPath, 'manifest.json');

  mkdirSync(backupsPath, { recursive: true });
  if (existsSync(directoryPath) || existsSync(temporaryDirectoryPath)) {
    throw new Error(`Refusing to overwrite backup ${directoryPath}`);
  }

  mkdirSync(temporaryDirectoryPath);
  try {
    options.database.exec(`VACUUM INTO ${sqliteString(temporaryDatabasePath)}`);
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
}
