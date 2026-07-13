import { mkdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import { Database } from 'bun:sqlite';

export const LOCK_FILE_NAME = '.colorful-code.instance.lock';
/** @deprecated Use LOCK_FILE_NAME. */
export const LOCK_DIRECTORY_NAME = LOCK_FILE_NAME;

const MAX_TRANSIENT_BUSY_ATTEMPTS = 8;

export class DataDirectoryLockConflictError extends Error {
  constructor(public readonly dataDirectory: string) {
    super(
      `Another Colorful Code daemon is already using data directory: ${dataDirectory}`,
    );
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

  private constructor(private readonly database: Database) {}

  static async acquire(
    dataDirectory: string,
  ): Promise<DataDirectoryInstanceLock> {
    await mkdir(dataDirectory, { recursive: true });
    const canonicalDirectory = await realpath(dataDirectory);
    const lockPath = join(canonicalDirectory, LOCK_FILE_NAME);

    for (
      let attempt = 1;
      attempt <= MAX_TRANSIENT_BUSY_ATTEMPTS;
      attempt += 1
    ) {
      let database: Database | undefined;
      try {
        database = new Database(lockPath, { create: true, readwrite: true });
        database.exec('PRAGMA busy_timeout = 0');
        // A newly created SQLite file is initially zero bytes. Initializing
        // that empty container before the long-lived transaction prevents the
        // first winner from holding an unparseable placeholder. VACUUM creates
        // no table, migration, or application schema.
        database.exec('VACUUM');
        database.exec('BEGIN EXCLUSIVE');
        return new DataDirectoryInstanceLock(database);
      } catch (acquireError) {
        const conflict = isLockConflict(acquireError);
        const reportedError = conflict
          ? new DataDirectoryLockConflictError(canonicalDirectory)
          : acquireError;
        if (database !== undefined) {
          try {
            database.close(true);
          } catch (closeError) {
            throw new AggregateError(
              [reportedError, closeError],
              'Data directory lock acquisition and cleanup failed',
            );
          }
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

    throw new DataDirectoryLockConflictError(canonicalDirectory);
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
      this.database.exec('ROLLBACK');
    } catch (error) {
      errors.push(error);
    }

    try {
      this.database.close(true);
      this.released = true;
    } catch (error) {
      errors.push(error);
    }

    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new AggregateError(errors, 'Data directory lock release failed');
    }
  }

  private clearReleaseAttempt(attempt: Promise<void>): void {
    if (this.releaseAttempt === attempt) this.releaseAttempt = undefined;
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
