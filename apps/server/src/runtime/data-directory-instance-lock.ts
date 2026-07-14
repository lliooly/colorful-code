import {
  chmod,
  lstat,
  mkdir,
  open,
  realpath,
  type FileHandle,
} from 'node:fs/promises';
import { join } from 'node:path';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import { Database } from 'bun:sqlite';

export const LOCK_FILE_NAME = '.colorful-code.instance.lock';
export const LOCK_APPLICATION_ID = 1_129_270_347;
/** @deprecated Use LOCK_FILE_NAME. */
export const LOCK_DIRECTORY_NAME = LOCK_FILE_NAME;

const MAX_TRANSIENT_BUSY_ATTEMPTS = 8;
const LOCK_GUARD_FILE_NAME = '.colorful-code.instance.guard';

interface FileIdentity {
  dev: number;
  ino: number;
}

interface OpenLockDatabase {
  database: Database;
  identity: FileIdentity;
  path: string;
}

export class DataDirectoryLockConflictError extends Error {
  readonly code = 'data_directory_in_use' as const;

  constructor() {
    super('Another Colorful Code daemon is already using this data directory');
    this.name = 'DataDirectoryLockConflictError';
  }
}

/**
 * An OS-backed, process-scoped lease on one canonical data directory.
 *
 * The dedicated SQLite connection stays in an exclusive transaction for the
 * daemon lifetime. SQLite and the operating system release the file lock when
 * this handle closes or when the process exits, including abnormal exits.
 */
export class DataDirectoryInstanceLock {
  private released = false;
  private releaseAttempt?: Promise<void>;

  private constructor(
    private readonly database: Database,
    private readonly guardDatabase: Database,
    private readonly lockPath: string,
    private readonly lockIdentity: FileIdentity,
    private readonly guardPath: string,
    private readonly guardIdentity: FileIdentity,
  ) {}

  static async acquire(
    dataDirectory: string,
  ): Promise<DataDirectoryInstanceLock> {
    const createdDirectory = await mkdir(dataDirectory, {
      recursive: true,
      mode: 0o700,
    });
    if (createdDirectory !== undefined) await chmod(dataDirectory, 0o700);
    const canonicalDirectory = await realpath(dataDirectory);
    const directoryMetadata = await lstat(canonicalDirectory);
    const directoryHandle = await open(canonicalDirectory, 'r');
    try {
      const openedMetadata = await directoryHandle.stat();
      if (
        !directoryMetadata.isDirectory() ||
        !openedMetadata.isDirectory() ||
        directoryMetadata.dev !== openedMetadata.dev ||
        directoryMetadata.ino !== openedMetadata.ino
      ) {
        throw new Error('Data directory identity changed during validation');
      }
      if ((openedMetadata.mode & 0o077) !== 0) {
        await directoryHandle.chmod(0o700);
      }
      const securedMetadata = await directoryHandle.stat();
      const securedPathMetadata = await lstat(canonicalDirectory);
      if (
        (securedMetadata.mode & 0o077) !== 0 ||
        securedMetadata.dev !== securedPathMetadata.dev ||
        securedMetadata.ino !== securedPathMetadata.ino
      ) {
        throw new Error('Data directory could not be secured to mode 0700');
      }
    } finally {
      await directoryHandle.close();
    }
    const lockPath = join(canonicalDirectory, LOCK_FILE_NAME);
    const guardPath = join(canonicalDirectory, LOCK_GUARD_FILE_NAME);

    for (
      let attempt = 1;
      attempt <= MAX_TRANSIENT_BUSY_ATTEMPTS;
      attempt += 1
    ) {
      let lock: OpenLockDatabase | undefined;
      let guard: OpenLockDatabase | undefined;
      try {
        // The guard remains locked even if the public lock pathname is
        // accidentally renamed or replaced. This prevents a second daemon
        // from treating the replacement as an independent lease.
        guard = await openLockDatabase(guardPath);
        lock = await openLockDatabase(lockPath);
        return new DataDirectoryInstanceLock(
          lock.database,
          guard.database,
          lock.path,
          lock.identity,
          guard.path,
          guard.identity,
        );
      } catch (acquireError) {
        const conflict = isLockConflict(acquireError);
        const reportedError = conflict
          ? new DataDirectoryLockConflictError()
          : acquireError;
        const cleanupErrors: unknown[] = [];
        for (const opened of [lock, guard]) {
          if (opened === undefined) continue;
          try {
            opened.database.close(true);
          } catch (closeError) {
            cleanupErrors.push(closeError);
          }
        }
        if (cleanupErrors.length > 0) {
          throw new AggregateError(
            [reportedError, ...cleanupErrors],
            'Data directory lock acquisition and cleanup failed',
          );
        }

        if (!conflict || attempt === MAX_TRANSIENT_BUSY_ATTEMPTS) {
          throw reportedError;
        }
        // SQLite itself never waits (busy_timeout=0). A bounded event-loop
        // yield only resolves the simultaneous first-open initialization race;
        // an established owner still produces a prompt, deterministic error.
        await yieldToEventLoop();
      }
    }

    throw new DataDirectoryLockConflictError();
  }

  async assertHealthy(): Promise<void> {
    await assertPathIdentity(this.lockPath, this.lockIdentity);
    await assertPathIdentity(this.guardPath, this.guardIdentity);
  }

  release(): Promise<void> {
    if (this.released) return Promise.resolve();
    if (this.releaseAttempt !== undefined) return this.releaseAttempt;

    const attempt = this.performRelease();
    this.releaseAttempt = attempt;
    void attempt.then(
      () => this.clearReleaseAttempt(attempt),
      () => this.clearReleaseAttempt(attempt),
    );
    return attempt;
  }

  private async performRelease(): Promise<void> {
    const errors: unknown[] = [];

    try {
      await this.assertHealthy();
    } catch (error) {
      errors.push(error);
    }

    for (const database of [this.database, this.guardDatabase]) {
      try {
        database.exec('ROLLBACK');
      } catch (error) {
        errors.push(error);
      }
    }

    let allClosed = true;
    for (const database of [this.database, this.guardDatabase]) {
      try {
        database.close(true);
      } catch (error) {
        allClosed = false;
        errors.push(error);
      }
    }
    this.released = allClosed;

    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new AggregateError(errors, 'Data directory lock release failed');
    }
  }

  private clearReleaseAttempt(attempt: Promise<void>): void {
    if (this.releaseAttempt === attempt) this.releaseAttempt = undefined;
  }
}

async function openLockDatabase(path: string): Promise<OpenLockDatabase> {
  let createdFile: FileHandle | undefined;
  try {
    createdFile = await open(path, 'wx', 0o600);
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
  } finally {
    await createdFile?.close();
  }

  const identityBeforeOpen = await validateLockFile(path);
  await chmod(path, 0o600);

  const database = new Database(path, { create: false, readwrite: true });
  try {
    const identityAfterOpen = await validateLockFile(path);
    assertSameIdentity(path, identityBeforeOpen, identityAfterOpen);

    database.exec('PRAGMA busy_timeout = 0');
    const existingApplicationId = readApplicationId(database);
    if (
      existingApplicationId !== 0 &&
      existingApplicationId !== LOCK_APPLICATION_ID
    ) {
      throw new Error(
        `Refusing lock file with unexpected SQLite application_id ${existingApplicationId}`,
      );
    }
    if (existingApplicationId === 0) {
      // Initialize a newly created zero-byte lock database with one fixed,
      // bounded header write. Startup must never run an unbounded VACUUM or
      // persist process/user metadata in the dedicated lock file.
      database.exec(`PRAGMA application_id = ${LOCK_APPLICATION_ID}`);
    }
    if (readApplicationId(database) !== LOCK_APPLICATION_ID) {
      throw new Error('Failed to initialize SQLite application_id');
    }

    const identityAfterInitialization = await validateLockFile(path);
    assertSameIdentity(path, identityBeforeOpen, identityAfterInitialization);
    database.exec('BEGIN EXCLUSIVE');
    return { database, identity: identityBeforeOpen, path };
  } catch (error) {
    database.close(true);
    throw error;
  }
}

function readApplicationId(database: Database): number {
  return (
    database
      .query<{ application_id: number }, []>('PRAGMA application_id')
      .get()?.application_id ?? 0
  );
}

async function validateLockFile(path: string): Promise<FileIdentity> {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink()) {
    throw new Error('Refusing symbolic link for data directory lock');
  }
  if (!metadata.isFile()) {
    throw new Error('Data directory lock must be a regular file');
  }
  if (metadata.nlink !== 1) {
    throw new Error(
      'Data directory lock must have exactly one filesystem link',
    );
  }
  return { dev: metadata.dev, ino: metadata.ino };
}

async function assertPathIdentity(
  path: string,
  expected: FileIdentity,
): Promise<void> {
  const actual = await validateLockFile(path);
  assertSameIdentity(path, expected, actual);
}

function assertSameIdentity(
  _path: string,
  expected: FileIdentity,
  actual: FileIdentity,
): void {
  if (actual.dev !== expected.dev || actual.ino !== expected.ino) {
    throw new Error('Data directory lock identity changed at runtime');
  }
}

function isLockConflict(error: unknown): boolean {
  if (!isObject(error)) return false;
  const code = error.code;
  return (
    typeof code === 'string' &&
    (code === 'SQLITE_BUSY' ||
      code.startsWith('SQLITE_BUSY_') ||
      code === 'SQLITE_LOCKED' ||
      code.startsWith('SQLITE_LOCKED_'))
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isAlreadyExists(error: unknown): boolean {
  return isObject(error) && error.code === 'EEXIST';
}
