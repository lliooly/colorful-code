import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import {
  DataDirectoryInstanceLock,
  DataDirectoryLockConflictError,
} from '../src/runtime/data-directory-instance-lock';
import {
  type DaemonApplication,
  startDaemon,
} from '../src/runtime/daemon-lifecycle';
import type { DatabaseProvider } from '../src/persistence/database-provider';

class FakeApplication implements DaemonApplication {
  closeCallbacks: Array<() => Promise<void>> = [];
  closeCalls = 0;
  listenCalls = 0;

  constructor(
    private readonly options: {
      events?: string[];
      listenError?: Error;
      closeError?: Error;
      runCallbacksOnClose?: boolean;
    } = {},
  ) {}

  onClose(callback: () => Promise<void>): void {
    this.options.events?.push('register-close');
    this.closeCallbacks.push(callback);
  }

  async listen(): Promise<void> {
    this.listenCalls += 1;
    this.options.events?.push('listen');
    if (this.options.listenError) throw this.options.listenError;
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
    this.options.events?.push('close-app');
    const errors: unknown[] = [];
    if (this.options.runCallbacksOnClose) {
      for (const callback of this.closeCallbacks) {
        try {
          await callback();
        } catch (error) {
          errors.push(error);
        }
      }
    }
    if (this.options.closeError) errors.unshift(this.options.closeError);
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, 'close failed');
  }
}

function fakeProvider(close: () => Promise<void>): DatabaseProvider {
  return { close } as DatabaseProvider;
}

test('owns migration, Provider, application, and lock in strict lifecycle order', async () => {
  const events: string[] = [];
  const provider = fakeProvider(async () => {
    events.push('close-provider');
  });
  const application = new FakeApplication({
    events,
    runCallbacksOnClose: true,
  });

  const started = await startDaemon({
    databasePath: '/data/database.sqlite',
    acquireLock: async () => {
      events.push('acquire-lock');
      return {
        release: async () => {
          events.push('release-lock');
        },
      };
    },
    migrateDatabase: async () => {
      events.push('migrate-and-close-bootstrap-connection');
    },
    createProvider: async () => {
      events.push('create-provider');
      return provider;
    },
    createApplication: async (_databasePath, receivedProvider) => {
      assert.equal(receivedProvider, provider);
      events.push('create-app');
      return application;
    },
  });
  await started.close();

  assert.deepEqual(events, [
    'acquire-lock',
    'migrate-and-close-bootstrap-connection',
    'create-provider',
    'create-app',
    'register-close',
    'listen',
    'close-app',
    'close-provider',
    'release-lock',
  ]);
});

test('Provider creation failure releases the lock before app creation', async () => {
  const providerError = new Error('provider failed');
  const events: string[] = [];

  await assert.rejects(
    startDaemon({
      databasePath: '/data/database.sqlite',
      acquireLock: async () => ({
        release: async () => {
          events.push('release-lock');
        },
      }),
      migrateDatabase: async () => {
        events.push('migrate');
      },
      createProvider: async () => {
        events.push('create-provider');
        throw providerError;
      },
      createApplication: async () => {
        events.push('create-app');
        return new FakeApplication();
      },
    }),
    (error) => error === providerError,
  );

  assert.deepEqual(events, ['migrate', 'create-provider', 'release-lock']);
});

test('Provider close failure keeps the Instance Lock fail-closed', async () => {
  const closeError = new Error('provider close failed');
  let lockReleaseCalls = 0;
  const application = new FakeApplication({ runCallbacksOnClose: true });
  const started = await startDaemon({
    databasePath: '/data/database.sqlite',
    acquireLock: async () => ({
      release: async () => {
        lockReleaseCalls += 1;
      },
    }),
    migrateDatabase: async () => undefined,
    createProvider: async () =>
      fakeProvider(async () => {
        throw closeError;
      }),
    createApplication: async () => application,
  });

  await assert.rejects(started.close(), (error) => error === closeError);
  assert.equal(lockReleaseCalls, 0);
});

test('acquires the lock and migrates before creating or listening to the app', async () => {
  const events: string[] = [];
  let locked = false;
  let appCreated = false;
  const application = new FakeApplication({ events });
  const originalCwd = process.cwd();
  const changedCwd = mkdtempSync(join(tmpdir(), 'colorful-code-cwd-'));
  const expectedDatabasePath = resolve('./relative/data.sqlite');
  let migratedDatabasePath: string | undefined;

  try {
    // Let Bun finish loading sibling node:test files before changing global cwd.
    await new Promise<void>((resolve) => setImmediate(resolve));
    await startDaemon({
      databasePath: './relative/data.sqlite',
      acquireLock: async (dataDirectory) => {
        assert.equal(dataDirectory, dirname(expectedDatabasePath));
        events.push('acquire-lock');
        locked = true;
        return { release: async () => undefined };
      },
      migrateDatabase: async (databasePath) => {
        migratedDatabasePath = databasePath;
        assert.equal(databasePath, expectedDatabasePath);
        assert.equal(locked, true);
        assert.equal(appCreated, false);
        events.push('migrate');
        process.chdir(changedCwd);
      },
      createApplication: async (databasePath) => {
        assert.equal(databasePath, migratedDatabasePath);
        assert.equal(databasePath, expectedDatabasePath);
        assert.equal(locked, true);
        appCreated = true;
        events.push('create-app');
        return application;
      },
    });
  } finally {
    process.chdir(originalCwd);
    rmSync(changedCwd, { recursive: true, force: true });
  }

  assert.deepEqual(events, [
    'acquire-lock',
    'migrate',
    'create-app',
    'register-close',
    'listen',
  ]);
});

test('a lock conflict prevents app creation and startup without releasing an unowned lock', async () => {
  let createCalls = 0;
  let migrateCalls = 0;
  const releaseCalls = 0;
  const application = new FakeApplication();
  const conflict = new DataDirectoryLockConflictError('/occupied');

  await assert.rejects(
    startDaemon({
      databasePath: '/occupied/data.sqlite',
      acquireLock: async () => {
        throw conflict;
      },
      migrateDatabase: async () => {
        migrateCalls += 1;
      },
      createApplication: async () => {
        createCalls += 1;
        return application;
      },
    }),
    (error) => error === conflict,
  );

  assert.equal(createCalls, 0);
  assert.equal(migrateCalls, 0);
  assert.equal(application.listenCalls, 0);
  assert.equal(releaseCalls, 0);
});

for (const databasePath of [
  'file::memory:evil',
  'file:/tmp/alias.db',
  'FILE:/tmp/alias.db',
]) {
  test(`rejects unsupported database URI ${databasePath} before lock or startup`, async () => {
    let acquireCalls = 0;
    let migrateCalls = 0;
    let createCalls = 0;

    await assert.rejects(
      startDaemon({
        databasePath,
        acquireLock: async () => {
          acquireCalls += 1;
          return { release: async () => undefined };
        },
        migrateDatabase: async () => {
          migrateCalls += 1;
        },
        createApplication: async () => {
          createCalls += 1;
          return new FakeApplication();
        },
      }),
      (error: unknown) =>
        error instanceof Error && error.name === 'DatabasePathError',
    );

    assert.equal(acquireCalls, 0);
    assert.equal(migrateCalls, 0);
    assert.equal(createCalls, 0);
  });
}

test('rejects a symbolic-link database before acquiring its directory lock', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'colorful-code-daemon-link-'));
  const targetPath = join(directory, 'target.db');
  const linkPath = join(directory, 'link.db');
  let acquireCalls = 0;

  try {
    writeFileSync(targetPath, '');
    symlinkSync(targetPath, linkPath);

    await assert.rejects(
      startDaemon({
        databasePath: linkPath,
        acquireLock: async () => {
          acquireCalls += 1;
          return { release: async () => undefined };
        },
        migrateDatabase: async () => undefined,
        createApplication: async () => new FakeApplication(),
      }),
      (error: unknown) =>
        error instanceof Error && error.name === 'DatabasePathError',
    );
    assert.equal(acquireCalls, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('releases the lock once and preserves an application creation error', async () => {
  const creationError = new Error('create failed');
  let releaseCalls = 0;

  await assert.rejects(
    startDaemon({
      databasePath: '/data/db.sqlite',
      acquireLock: async () => ({
        release: async () => {
          releaseCalls += 1;
        },
      }),
      migrateDatabase: async () => undefined,
      createApplication: async () => {
        throw creationError;
      },
    }),
    (error) => error === creationError,
  );

  assert.equal(releaseCalls, 1);
});

test('releases the real data-directory lock when application creation fails', async () => {
  const dataDirectory = mkdtempSync(
    join(tmpdir(), 'colorful-code-create-failure-'),
  );
  const creationError = new Error('Nest initialization failed');

  try {
    await assert.rejects(
      startDaemon({
        databasePath: join(dataDirectory, 'data.sqlite'),
        createApplication: async () => {
          throw creationError;
        },
      }),
      (error) => error === creationError,
    );

    const nextLock = await DataDirectoryInstanceLock.acquire(dataDirectory);
    await nextLock.release();
  } finally {
    rmSync(dataDirectory, { recursive: true, force: true });
  }
});

test('a listen failure closes the app before directly releasing its lock', async () => {
  const events: string[] = [];
  const listenError = new Error('listen failed');
  let releaseCalls = 0;
  const application = new FakeApplication({ events, listenError });

  await assert.rejects(
    startDaemon({
      databasePath: '/data/db.sqlite',
      acquireLock: async () => ({
        release: async () => {
          releaseCalls += 1;
          events.push('release-lock');
        },
      }),
      migrateDatabase: async () => undefined,
      createApplication: async () => application,
    }),
    (error) => error === listenError,
  );

  assert.equal(application.closeCallbacks.length, 1);
  assert.deepEqual(events.slice(-2), ['close-app', 'release-lock']);
  assert.equal(releaseCalls, 1);
});

test('normal repeated app close physically releases the lock only once', async () => {
  let physicalReleases = 0;
  const lock = {
    release: async () => {
      physicalReleases += 1;
    },
  };
  const application = new FakeApplication({ runCallbacksOnClose: true });

  await startDaemon({
    databasePath: '/data/db.sqlite',
    acquireLock: async () => lock,
    migrateDatabase: async () => undefined,
    createApplication: async () => application,
  });
  await application.close();
  await application.close();

  assert.equal(physicalReleases, 1);
});

test('normal app close retries a failed physical release on the next close', async () => {
  const firstReleaseError = new Error('first release failed');
  let physicalAttempts = 0;
  const application = new FakeApplication({ runCallbacksOnClose: true });

  await startDaemon({
    databasePath: '/data/db.sqlite',
    acquireLock: async () => ({
      release: async () => {
        physicalAttempts += 1;
        if (physicalAttempts === 1) throw firstReleaseError;
      },
    }),
    migrateDatabase: async () => undefined,
    createApplication: async () => application,
  });

  await assert.rejects(
    application.close(),
    (error) => error === firstReleaseError,
  );
  await application.close();
  assert.equal(physicalAttempts, 2);
});

test('listen cleanup shares one physical release with the onClose callback', async () => {
  const listenError = new Error('listen failed');
  let physicalReleases = 0;
  const application = new FakeApplication({
    listenError,
    runCallbacksOnClose: true,
  });

  await assert.rejects(
    startDaemon({
      databasePath: '/data/db.sqlite',
      acquireLock: async () => ({
        release: async () => {
          physicalReleases += 1;
        },
      }),
      migrateDatabase: async () => undefined,
      createApplication: async () => application,
    }),
    (error) => error === listenError,
  );

  assert.equal(physicalReleases, 1);
});

test('listen cleanup reports a cached release failure swallowed by app close', async () => {
  const listenError = new Error('listen failed');
  const releaseError = new Error('release failed');
  let closeCallback: (() => Promise<void>) | undefined;
  let physicalReleases = 0;
  const application: DaemonApplication = {
    onClose(callback) {
      closeCallback = callback;
    },
    async listen() {
      throw listenError;
    },
    async close() {
      try {
        await closeCallback?.();
      } catch {
        // This adapter intentionally swallows callback errors.
      }
    },
  };

  await assert.rejects(
    startDaemon({
      databasePath: '/data/db.sqlite',
      acquireLock: async () => ({
        release: async () => {
          physicalReleases += 1;
          throw releaseError;
        },
      }),
      migrateDatabase: async () => undefined,
      createApplication: async () => application,
    }),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [listenError, releaseError]);
      return true;
    },
  );

  assert.equal(physicalReleases, 1);
});

test('listen cleanup reports close and callback release failures without duplicating release', async () => {
  const listenError = new Error('listen failed');
  const closeError = new Error('close failed');
  const releaseError = new Error('release failed');
  let physicalReleases = 0;
  const application = new FakeApplication({
    listenError,
    closeError,
    runCallbacksOnClose: true,
  });

  await assert.rejects(
    startDaemon({
      databasePath: '/data/db.sqlite',
      acquireLock: async () => ({
        release: async () => {
          physicalReleases += 1;
          throw releaseError;
        },
      }),
      migrateDatabase: async () => undefined,
      createApplication: async () => application,
    }),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.errors[0], listenError);
      assert.ok(error.errors[1] instanceof AggregateError);
      assert.deepEqual(error.errors[1].errors, [closeError, releaseError]);
      assert.equal(error.errors.length, 2);
      return true;
    },
  );

  assert.equal(physicalReleases, 1);
});

test('listen cleanup finds a release error through cyclic causes without duplicating it', async () => {
  const listenError = new Error('listen failed');
  const releaseError = new Error('release failed');
  const wrapper = new Error('wrapped release failure');
  const nested = new AggregateError([releaseError], 'nested', {
    cause: wrapper,
  });
  Object.defineProperty(wrapper, 'cause', { value: nested });
  let closeCallback: (() => Promise<void>) | undefined;
  let physicalReleases = 0;
  const application: DaemonApplication = {
    onClose(callback) {
      closeCallback = callback;
    },
    async listen() {
      throw listenError;
    },
    async close() {
      try {
        await closeCallback?.();
      } catch {
        throw wrapper;
      }
    },
  };

  await assert.rejects(
    startDaemon({
      databasePath: '/data/db.sqlite',
      acquireLock: async () => ({
        release: async () => {
          physicalReleases += 1;
          throw releaseError;
        },
      }),
      migrateDatabase: async () => undefined,
      createApplication: async () => application,
    }),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [listenError, wrapper]);
      return true;
    },
  );

  assert.equal(physicalReleases, 1);
});

test('aggregates a startup error with both app-close and lock-release failures', async () => {
  const listenError = new Error('listen failed');
  const closeError = new Error('close failed');
  const releaseError = new Error('release failed');
  const application = new FakeApplication({ listenError, closeError });

  await assert.rejects(
    startDaemon({
      databasePath: '/data/db.sqlite',
      acquireLock: async () => ({
        release: async () => {
          throw releaseError;
        },
      }),
      migrateDatabase: async () => undefined,
      createApplication: async () => application,
    }),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [listenError, closeError, releaseError]);
      return true;
    },
  );
});

test('aggregates an app creation error with lock-release failure', async () => {
  const creationError = new Error('create failed');
  const releaseError = new Error('release failed');

  await assert.rejects(
    startDaemon({
      databasePath: '/data/db.sqlite',
      acquireLock: async () => ({
        release: async () => {
          throw releaseError;
        },
      }),
      migrateDatabase: async () => undefined,
      createApplication: async () => {
        throw creationError;
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [creationError, releaseError]);
      return true;
    },
  );
});

test('aggregates a startup error with an app-close failure when lock release succeeds', async () => {
  const listenError = new Error('listen failed');
  const closeError = new Error('close failed');
  const application = new FakeApplication({ listenError, closeError });

  await assert.rejects(
    startDaemon({
      databasePath: '/data/db.sqlite',
      acquireLock: async () => ({ release: async () => undefined }),
      migrateDatabase: async () => undefined,
      createApplication: async () => application,
    }),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [listenError, closeError]);
      return true;
    },
  );
});

for (const databasePath of [
  ':memory:',
  '',
  'file::memory:',
  'file::memory:?cache=shared',
]) {
  test(`rejects unsupported in-memory path ${JSON.stringify(databasePath)} before startup`, async () => {
    let acquireCalls = 0;
    let migrateCalls = 0;
    let createCalls = 0;
    const application = new FakeApplication();

    await assert.rejects(
      startDaemon({
        databasePath,
        acquireLock: async () => {
          acquireCalls += 1;
          return { release: async () => undefined };
        },
        migrateDatabase: async () => {
          migrateCalls += 1;
        },
        createApplication: async () => {
          createCalls += 1;
          return application;
        },
      }),
      (error: unknown) =>
        error instanceof Error &&
        error.name === 'DatabasePathError' &&
        (error as Error & { code?: unknown }).code ===
          'in_memory_database_unsupported',
    );

    assert.equal(acquireCalls, 0);
    assert.equal(migrateCalls, 0);
    assert.equal(createCalls, 0);
    assert.equal(application.listenCalls, 0);
  });
}

test('migration failure prevents app creation and releases the owned lock once', async () => {
  const migrationError = new Error('migration failed');
  let createCalls = 0;
  let releaseCalls = 0;
  const application = new FakeApplication();

  await assert.rejects(
    startDaemon({
      databasePath: '/data/db.sqlite',
      acquireLock: async () => ({
        release: async () => {
          releaseCalls += 1;
        },
      }),
      migrateDatabase: async () => {
        throw migrationError;
      },
      createApplication: async () => {
        createCalls += 1;
        return application;
      },
    }),
    (error) => error === migrationError,
  );

  assert.equal(createCalls, 0);
  assert.equal(application.listenCalls, 0);
  assert.equal(releaseCalls, 1);
});

test('aggregates migration and lock-release failures in primary-first order', async () => {
  const migrationError = new Error('migration failed');
  const releaseError = new Error('release failed');

  await assert.rejects(
    startDaemon({
      databasePath: '/data/db.sqlite',
      acquireLock: async () => ({
        release: async () => {
          throw releaseError;
        },
      }),
      migrateDatabase: () => {
        throw migrationError;
      },
      createApplication: async () => new FakeApplication(),
    }),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [migrationError, releaseError]);
      return true;
    },
  );
});
