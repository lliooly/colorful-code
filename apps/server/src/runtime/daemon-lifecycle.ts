import { resolveDatabasePath } from '../persistence/database-path';
import { bootstrapMigrations } from '../persistence/migration-bootstrap';
import { DataDirectoryInstanceLock } from './data-directory-instance-lock';

export interface InstanceLockHandle {
  release(): Promise<void>;
}

export interface DaemonApplication {
  listen(): Promise<void>;
  close(): Promise<void>;
  onClose(callback: () => Promise<void>): void;
}

export interface StartDaemonOptions {
  databasePath: string;
  acquireLock?: (dataDirectory: string) => Promise<InstanceLockHandle>;
  migrateDatabase?: (databasePath: string) => void | Promise<void>;
  createApplication: (databasePath: string) => Promise<DaemonApplication>;
}

export async function startDaemon(
  options: StartDaemonOptions,
): Promise<DaemonApplication> {
  const resolvedPath = await resolveDatabasePath(options.databasePath);
  const acquireLock =
    options.acquireLock ??
    DataDirectoryInstanceLock.acquire.bind(DataDirectoryInstanceLock);
  const migrateDatabase = options.migrateDatabase ?? bootstrapMigrations;
  let releaseCoordinator: ReleaseCoordinator | undefined;
  let application: DaemonApplication | undefined;

  try {
    const lock = await acquireLock(resolvedPath.dataDirectory);
    releaseCoordinator = createReleaseCoordinator(lock);
    await migrateDatabase(resolvedPath.databasePath);
    application = await options.createApplication(resolvedPath.databasePath);
    application.onClose(releaseCoordinator.release);
    await application.listen();
    return application;
  } catch (startupError) {
    if (releaseCoordinator === undefined) throw startupError;

    const errors: unknown[] = [startupError];
    const releaseAttemptsBeforeClose = releaseCoordinator.attemptCount;
    if (application !== undefined) {
      try {
        await application.close();
      } catch (closeError) {
        errors.push(closeError);
      }
    }
    try {
      const releaseAttempt =
        releaseCoordinator.attemptCount > releaseAttemptsBeforeClose
          ? releaseCoordinator.lastAttempt!
          : releaseCoordinator.release();
      await releaseAttempt;
    } catch (releaseError) {
      if (!errors.some((error) => errorContainsIdentity(error, releaseError))) {
        errors.push(releaseError);
      }
    }

    if (errors.length === 1) throw startupError;
    throw new AggregateError(errors, 'Daemon startup and cleanup failed');
  }
}

interface ReleaseCoordinator {
  readonly release: () => Promise<void>;
  readonly attemptCount: number;
  readonly lastAttempt: Promise<void> | undefined;
}

function createReleaseCoordinator(
  lock: InstanceLockHandle,
): ReleaseCoordinator {
  let attemptCount = 0;
  let inFlightOrSuccessful: Promise<void> | undefined;
  let lastAttempt: Promise<void> | undefined;

  const release = (): Promise<void> => {
    if (inFlightOrSuccessful !== undefined) return inFlightOrSuccessful;

    attemptCount += 1;
    const physicalAttempt = Promise.resolve().then(() => lock.release());
    const trackedAttempt = physicalAttempt.then(
      () => undefined,
      (error: unknown) => {
        if (inFlightOrSuccessful === trackedAttempt) {
          inFlightOrSuccessful = undefined;
        }
        throw error;
      },
    );
    inFlightOrSuccessful = trackedAttempt;
    lastAttempt = trackedAttempt;
    return trackedAttempt;
  };

  return {
    release,
    get attemptCount() {
      return attemptCount;
    },
    get lastAttempt() {
      return lastAttempt;
    },
  };
}

function errorContainsIdentity(
  error: unknown,
  target: unknown,
  seen = new Set<unknown>(),
): boolean {
  if (error === target) return true;
  if (
    ((typeof error !== 'object' || error === null) &&
      typeof error !== 'function') ||
    seen.has(error)
  ) {
    return false;
  }
  seen.add(error);

  if (
    error instanceof AggregateError &&
    error.errors.some((nestedError) =>
      errorContainsIdentity(nestedError, target, seen),
    )
  ) {
    return true;
  }

  return (
    error instanceof Error &&
    'cause' in error &&
    errorContainsIdentity(error.cause, target, seen)
  );
}
