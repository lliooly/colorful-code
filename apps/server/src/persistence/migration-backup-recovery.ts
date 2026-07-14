import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
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

export interface QuarantinedDatabase {
  readonly directoryPath: string;
  readonly databasePath?: string;
  readonly walPath?: string;
  readonly shmPath?: string;
}

export type MigrationBackupRecoveryErrorCode =
  | 'backup_invalid'
  | 'recovery_refused'
  | 'quarantine_failed'
  | 'recovery_failed';

export class MigrationBackupRecoveryError extends Error {
  readonly code: MigrationBackupRecoveryErrorCode;
  readonly backupPath?: string;
  readonly targetPath?: string;

  constructor(
    code: MigrationBackupRecoveryErrorCode,
    message: string,
    options?: { cause?: unknown; backupPath?: string; targetPath?: string },
  ) {
    super(message, { cause: options?.cause });
    this.name = 'MigrationBackupRecoveryError';
    this.code = code;
    this.backupPath = options?.backupPath;
    this.targetPath = options?.targetPath;
  }
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

function resolvePersistentDatabasePath(databasePath: string): string {
  if (
    typeof databasePath !== 'string' ||
    databasePath.length === 0 ||
    databasePath === ':memory:' ||
    databasePath.startsWith('file:')
  ) {
    throw new TypeError('Database path must name a persistent file');
  }
  return resolve(databasePath);
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

interface ReservationIdentity {
  readonly dev: number;
  readonly ino: number;
}

function removeOwnedReservation(
  reservationPath: string,
  owned: ReservationIdentity,
): void {
  let current: ReturnType<typeof lstatSync>;
  try {
    current = lstatSync(reservationPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }

  if (current.dev === owned.dev && current.ino === owned.ino) {
    unlinkSync(reservationPath);
  }
}

function fileIdentity(path: string): ReservationIdentity {
  const stat = lstatSync(path);
  return { dev: stat.dev, ino: stat.ino };
}

function pathEntryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function removeOwnedDirectory(
  directoryPath: string,
  owned: ReservationIdentity,
): void {
  let current: ReturnType<typeof lstatSync>;
  try {
    current = lstatSync(directoryPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (
    current.isDirectory() &&
    !current.isSymbolicLink() &&
    current.dev === owned.dev &&
    current.ino === owned.ino
  ) {
    rmSync(directoryPath, { recursive: true, force: true });
  }
}

function checksumFile(path: string): { sizeBytes: number; sha256: string } {
  const descriptor = openSync(path, 'r');
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let sizeBytes = 0;
  try {
    while (true) {
      const bytesRead = readSync(
        descriptor,
        buffer,
        0,
        buffer.byteLength,
        null,
      );
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      sizeBytes += bytesRead;
    }
  } finally {
    closeSync(descriptor);
  }
  return { sizeBytes, sha256: hash.digest('hex') };
}

/** @internal Test-only access to narrow file-integrity helpers. */
export const __migrationBackupRecoveryTesting = Object.freeze({
  checksumFile,
  removeOwnedReservation,
});

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

export function quarantineDatabase(options: {
  databasePath: string;
  now?: () => Date;
  randomId?: () => string;
}): QuarantinedDatabase {
  const sourcePath = resolvePersistentDatabasePath(options.databasePath);
  if (!pathEntryExists(sourcePath)) {
    throw new MigrationBackupRecoveryError(
      'quarantine_failed',
      'Cannot quarantine a missing database',
      { targetPath: sourcePath },
    );
  }
  const sourceStat = lstatSync(sourcePath);
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
    throw new MigrationBackupRecoveryError(
      'quarantine_failed',
      'Quarantine source must be a regular database file',
      { targetPath: sourcePath },
    );
  }

  const now = (options.now ?? (() => new Date()))();
  assertValidDate(now);
  const randomId = (options.randomId ?? randomUUID)();
  assertSafePathSegment(randomId);
  const id = `${compactUtcTimestamp(now)}-${randomId}`;
  const quarantineRoot = join(dirname(sourcePath), 'migration-quarantine');
  const directoryPath = join(quarantineRoot, id);
  const reservationPath = join(quarantineRoot, `.${id}.reserve`);
  mkdirSync(quarantineRoot, { recursive: true });

  let reservation: number;
  try {
    reservation = openSync(reservationPath, 'wx');
  } catch (cause) {
    throw new MigrationBackupRecoveryError(
      'quarantine_failed',
      'Unable to reserve quarantine destination',
      { cause, targetPath: sourcePath },
    );
  }
  let reservationIdentity: ReservationIdentity | undefined;
  try {
    const reservationStat = fstatSync(reservation);
    reservationIdentity = {
      dev: reservationStat.dev,
      ino: reservationStat.ino,
    };
    if (pathEntryExists(directoryPath)) {
      throw new Error('Quarantine destination already exists');
    }
    mkdirSync(directoryPath);
    const fileName = basename(sourcePath);
    const result: {
      directoryPath: string;
      databasePath?: string;
      walPath?: string;
      shmPath?: string;
    } = { directoryPath };
    for (const [property, source, destinationName] of [
      ['databasePath', sourcePath, fileName],
      ['walPath', `${sourcePath}-wal`, `${fileName}-wal`],
      ['shmPath', `${sourcePath}-shm`, `${fileName}-shm`],
    ] as const) {
      if (pathEntryExists(source)) {
        const destination = join(directoryPath, destinationName);
        if (pathEntryExists(destination))
          throw new Error('Refusing to overwrite');
        renameSync(source, destination);
        result[property] = destination;
      }
    }
    return result;
  } catch (cause) {
    throw new MigrationBackupRecoveryError(
      'quarantine_failed',
      'Failed to quarantine database',
      { cause, targetPath: sourcePath },
    );
  } finally {
    try {
      closeSync(reservation);
    } finally {
      if (reservationIdentity) {
        removeOwnedReservation(reservationPath, reservationIdentity);
      }
    }
  }
}

export interface RestoreMigrationBackupOptions {
  readonly backup: MigrationBackup;
  readonly targetDatabasePath: string;
  readonly quarantine?: QuarantinedDatabase;
  readonly randomId?: () => string;
  /** @internal Narrow fault-injection seams for recovery tests. */
  readonly operations?: {
    readonly openDatabase?: typeof Database;
    readonly link?: typeof linkSync;
    readonly verify?: typeof verifyDatabase;
    readonly beforePublish?: () => void;
  };
}

function invalidBackup(
  backupPath: string,
  targetPath: string,
  cause?: unknown,
): MigrationBackupRecoveryError {
  return new MigrationBackupRecoveryError(
    'backup_invalid',
    'Migration backup failed trust validation',
    { backupPath, targetPath, cause },
  );
}

function readVerifiedManifest(
  backup: MigrationBackup,
  targetPath: string,
  verify: typeof verifyDatabase,
): { manifest: MigrationBackupManifest; databasePath: string } {
  const directoryPath = resolve(backup.directoryPath);
  const manifestPath = resolve(backup.manifestPath);
  if (
    manifestPath !== join(directoryPath, 'manifest.json') ||
    resolve(dirname(manifestPath)) !== directoryPath
  ) {
    throw invalidBackup(backup.directoryPath, targetPath);
  }

  try {
    const directoryStat = lstatSync(directoryPath);
    const manifestStat = lstatSync(manifestPath);
    if (
      !directoryStat.isDirectory() ||
      directoryStat.isSymbolicLink() ||
      !manifestStat.isFile() ||
      manifestStat.isSymbolicLink()
    ) {
      throw new Error('unsafe backup paths');
    }
    const value: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (typeof value !== 'object' || value === null)
      throw new Error('manifest');
    const manifest = value as Record<string, unknown>;
    const expectedKeys = [
      'createdAt',
      'databaseFile',
      'foreignKeyViolations',
      'formatVersion',
      'integrityCheck',
      'sha256',
      'sizeBytes',
      'sourceDatabasePath',
      'sourceSchemaVersion',
      'targetSchemaVersion',
    ];
    const createdAt = manifest.createdAt;
    const databaseFile = manifest.databaseFile;
    if (
      JSON.stringify(Object.keys(manifest).sort()) !==
        JSON.stringify(expectedKeys) ||
      manifest.formatVersion !== 1 ||
      typeof manifest.sourceDatabasePath !== 'string' ||
      !isAbsolute(manifest.sourceDatabasePath) ||
      manifest.sourceDatabasePath !== targetPath ||
      !Number.isSafeInteger(manifest.sourceSchemaVersion) ||
      (manifest.sourceSchemaVersion as number) < 0 ||
      !Number.isSafeInteger(manifest.targetSchemaVersion) ||
      (manifest.targetSchemaVersion as number) < 0 ||
      typeof createdAt !== 'string' ||
      !Number.isFinite(new Date(createdAt).getTime()) ||
      new Date(createdAt).toISOString() !== createdAt ||
      databaseFile !== 'colorful-code.db' ||
      !Number.isSafeInteger(manifest.sizeBytes) ||
      (manifest.sizeBytes as number) < 0 ||
      typeof manifest.sha256 !== 'string' ||
      !/^[0-9a-f]{64}$/.test(manifest.sha256) ||
      manifest.integrityCheck !== 'ok' ||
      manifest.foreignKeyViolations !== 0
    ) {
      throw new Error('invalid manifest fields');
    }
    const databasePath = join(directoryPath, databaseFile);
    const databaseStat = lstatSync(databasePath);
    if (
      resolve(backup.databasePath) !== databasePath ||
      resolve(dirname(backup.databasePath)) !== directoryPath ||
      !databaseStat.isFile() ||
      databaseStat.isSymbolicLink()
    ) {
      throw new Error('inconsistent backup paths');
    }
    const checksum = checksumFile(databasePath);
    if (
      checksum.sizeBytes !== manifest.sizeBytes ||
      checksum.sha256 !== manifest.sha256
    ) {
      throw new Error('backup checksum mismatch');
    }
    verify(databasePath);
    return {
      manifest: manifest as unknown as MigrationBackupManifest,
      databasePath,
    };
  } catch (cause) {
    if (cause instanceof MigrationBackupRecoveryError) throw cause;
    throw invalidBackup(backup.directoryPath, targetPath, cause);
  }
}

function quarantinePublishedFailure(
  targetPath: string,
  quarantine: QuarantinedDatabase | undefined,
  id: string,
  rename: typeof renameSync,
): void {
  if (!quarantine) {
    quarantineDatabase({ databasePath: targetPath });
    return;
  }
  const failurePath = join(quarantine.directoryPath, `restore-failure-${id}`);
  if (pathEntryExists(failurePath))
    throw new Error('Failure quarantine exists');
  mkdirSync(failurePath);
  const fileName = basename(targetPath);
  for (const [source, name] of [
    [targetPath, fileName],
    [`${targetPath}-wal`, `${fileName}-wal`],
    [`${targetPath}-shm`, `${fileName}-shm`],
  ]) {
    if (pathEntryExists(source)) rename(source, join(failurePath, name));
  }
}

export function restoreMigrationBackup(
  options: RestoreMigrationBackupOptions,
): void {
  const targetPath = resolvePersistentDatabasePath(options.targetDatabasePath);
  const assertVacantRecoveryTarget = (): void => {
    for (const path of [targetPath, `${targetPath}-wal`, `${targetPath}-shm`]) {
      if (!pathEntryExists(path)) continue;
      throw new MigrationBackupRecoveryError(
        'recovery_refused',
        'Refusing to overwrite an existing recovery target',
        { backupPath: options.backup.directoryPath, targetPath },
      );
    }
  };
  assertVacantRecoveryTarget();

  const verify = options.operations?.verify ?? verifyDatabase;
  const { databasePath } = readVerifiedManifest(
    options.backup,
    targetPath,
    verify,
  );
  const id = (options.randomId ?? randomUUID)();
  assertSafePathSegment(id);
  const temporaryDirectoryPath = join(
    dirname(targetPath),
    `.restore-${id}.tmp`,
  );
  const temporaryPath = join(temporaryDirectoryPath, 'colorful-code.db');
  const reservationPath = join(dirname(targetPath), `.restore-${id}.reserve`);
  const link = options.operations?.link ?? linkSync;
  const OpenDatabase = options.operations?.openDatabase ?? Database;

  let reservation: number;
  try {
    reservation = openSync(reservationPath, 'wx');
  } catch (cause) {
    throw new MigrationBackupRecoveryError(
      'recovery_failed',
      'Unable to reserve restore destination',
      { cause, backupPath: databasePath, targetPath },
    );
  }
  let reservationIdentity: ReservationIdentity | undefined;
  let temporaryDirectoryIdentity: ReservationIdentity | undefined;
  let published = false;
  try {
    reservationIdentity = fileIdentity(reservationPath);
    if (pathEntryExists(temporaryDirectoryPath))
      throw new Error('Restore temp already exists');
    mkdirSync(temporaryDirectoryPath);
    temporaryDirectoryIdentity = fileIdentity(temporaryDirectoryPath);
    const source = new OpenDatabase(databasePath, { readonly: true });
    try {
      source.exec(`VACUUM INTO ${sqliteString(temporaryPath)}`);
    } finally {
      source.close();
    }
    verify(temporaryPath);
    options.operations?.beforePublish?.();
    assertVacantRecoveryTarget();
    try {
      link(temporaryPath, targetPath);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new MigrationBackupRecoveryError(
          'recovery_refused',
          'Refusing to overwrite an existing recovery target',
          { cause, backupPath: databasePath, targetPath },
        );
      }
      throw cause;
    }
    published = true;
    if (
      pathEntryExists(`${targetPath}-wal`) ||
      pathEntryExists(`${targetPath}-shm`)
    ) {
      throw new Error('SQLite sidecar appeared during recovery publication');
    }
    unlinkSync(temporaryPath);
    removeOwnedDirectory(temporaryDirectoryPath, temporaryDirectoryIdentity);
    temporaryDirectoryIdentity = undefined;
    verify(targetPath);
  } catch (cause) {
    if (published) {
      let quarantineCause: unknown;
      try {
        quarantinePublishedFailure(
          targetPath,
          options.quarantine,
          id,
          renameSync,
        );
      } catch (error) {
        quarantineCause = error;
      }
      let cleanupCause: unknown;
      if (temporaryDirectoryIdentity) {
        try {
          removeOwnedDirectory(
            temporaryDirectoryPath,
            temporaryDirectoryIdentity,
          );
          temporaryDirectoryIdentity = undefined;
        } catch (error) {
          cleanupCause = error;
        }
      }
      if (quarantineCause !== undefined) {
        const errors = [cause, quarantineCause];
        if (cleanupCause !== undefined) errors.push(cleanupCause);
        throw new MigrationBackupRecoveryError(
          'recovery_failed',
          'Restore failed and the published target could not be quarantined',
          {
            cause: new AggregateError(errors),
            backupPath: databasePath,
            targetPath,
          },
        );
      }
      if (cleanupCause !== undefined) {
        throw new MigrationBackupRecoveryError(
          'recovery_failed',
          'Restore failed and its staging directory could not be cleaned',
          {
            cause: new AggregateError([cause, cleanupCause]),
            backupPath: databasePath,
            targetPath,
          },
        );
      }
    } else if (temporaryDirectoryIdentity) {
      try {
        removeOwnedDirectory(
          temporaryDirectoryPath,
          temporaryDirectoryIdentity,
        );
        temporaryDirectoryIdentity = undefined;
      } catch (cleanupCause) {
        throw new MigrationBackupRecoveryError(
          'recovery_failed',
          'Restore failed and its staging directory could not be cleaned',
          {
            cause: new AggregateError([cause, cleanupCause]),
            backupPath: databasePath,
            targetPath,
          },
        );
      }
    }
    if (
      cause instanceof MigrationBackupRecoveryError &&
      cause.code === 'recovery_refused'
    ) {
      throw cause;
    }
    throw new MigrationBackupRecoveryError(
      'recovery_failed',
      'Migration backup recovery failed',
      { cause, backupPath: databasePath, targetPath },
    );
  } finally {
    try {
      closeSync(reservation);
    } finally {
      if (reservationIdentity) {
        removeOwnedReservation(reservationPath, reservationIdentity);
      }
    }
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
  // Cooperative no-replace protocol: every migration-backup writer runs under
  // the Instance Lock and must reserve this ID through this function. Hostile or
  // non-cooperating filesystem mutation is outside this trust boundary.
  let reservation: number;
  try {
    reservation = openSync(reservationPath, 'wx');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`Backup reservation already exists: ${reservationPath}`);
    }
    throw error;
  }
  let reservationIdentity: ReservationIdentity | undefined;
  let temporaryDirectoryIdentity: ReservationIdentity | undefined;
  try {
    const reservationStat = fstatSync(reservation);
    reservationIdentity = {
      dev: reservationStat.dev,
      ino: reservationStat.ino,
    };
    if (
      pathEntryExists(directoryPath) ||
      pathEntryExists(temporaryDirectoryPath)
    ) {
      throw new Error(`Refusing to overwrite backup ${directoryPath}`);
    }

    mkdirSync(temporaryDirectoryPath);
    temporaryDirectoryIdentity = fileIdentity(temporaryDirectoryPath);
    try {
      options.database.exec(
        `VACUUM INTO ${sqliteString(temporaryDatabasePath)}`,
      );
      verifyDatabase(temporaryDatabasePath);

      const checksum = checksumFile(temporaryDatabasePath);
      const manifest: MigrationBackupManifest = {
        formatVersion: 1,
        sourceDatabasePath,
        sourceSchemaVersion: options.sourceSchemaVersion,
        targetSchemaVersion: options.targetSchemaVersion,
        createdAt: createdAt.toISOString(),
        databaseFile,
        sizeBytes: checksum.sizeBytes,
        sha256: checksum.sha256,
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
      try {
        removeOwnedDirectory(
          temporaryDirectoryPath,
          temporaryDirectoryIdentity,
        );
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError]);
      }
      throw error;
    }
  } finally {
    try {
      closeSync(reservation);
    } finally {
      if (reservationIdentity) {
        removeOwnedReservation(reservationPath, reservationIdentity);
      }
    }
  }
}
