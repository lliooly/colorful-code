import { dirname, resolve } from 'node:path';
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
  createApplication: () => Promise<DaemonApplication>;
}

const NOOP_LOCK: InstanceLockHandle = {
  release: async () => undefined,
};

export async function startDaemon(
  options: StartDaemonOptions,
): Promise<DaemonApplication> {
  const dataDirectory = resolveDataDirectory(options.databasePath);
  const acquireLock =
    options.acquireLock ??
    DataDirectoryInstanceLock.acquire.bind(DataDirectoryInstanceLock);
  let lock: InstanceLockHandle | undefined;
  let application: DaemonApplication | undefined;

  try {
    lock =
      dataDirectory === undefined
        ? NOOP_LOCK
        : await acquireLock(dataDirectory);
    application = await options.createApplication();
    application.onClose(() => lock!.release());
    await application.listen();
    return application;
  } catch (startupError) {
    if (lock === undefined) throw startupError;

    const errors: unknown[] = [startupError];
    if (application !== undefined) {
      try {
        await application.close();
      } catch (closeError) {
        errors.push(closeError);
      }
    }
    try {
      await lock.release();
    } catch (releaseError) {
      errors.push(releaseError);
    }

    if (errors.length === 1) throw startupError;
    throw new AggregateError(errors, 'Daemon startup and cleanup failed');
  }
}

function resolveDataDirectory(databasePath: string): string | undefined {
  if (
    databasePath === '' ||
    databasePath === ':memory:' ||
    databasePath.startsWith('file::memory:')
  ) {
    return undefined;
  }
  return dirname(resolve(databasePath));
}
