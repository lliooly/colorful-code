import { strict as assert } from 'node:assert';
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  symlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Database } from 'bun:sqlite';
import {
  DataDirectoryInstanceLock,
  DataDirectoryLockConflictError,
  LOCK_APPLICATION_ID,
  LOCK_FILE_NAME,
} from '../src/runtime/data-directory-instance-lock';

const HOLDER_FIXTURE = join(
  import.meta.dir,
  'fixtures',
  'instance-lock-holder.ts',
);

test('a second lock for the same data directory reports a clear conflict', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'colorful-code-lock-'));
  const first = await DataDirectoryInstanceLock.acquire(directory);

  try {
    await assert.rejects(
      DataDirectoryInstanceLock.acquire(directory),
      (error: unknown) => {
        assert.ok(error instanceof DataDirectoryLockConflictError);
        assert.equal(error.code, 'data_directory_in_use');
        assert.equal(
          error.message,
          'Another Colorful Code daemon is already using this data directory',
        );
        assert.doesNotMatch(JSON.stringify(error), new RegExp(directory));
        return true;
      },
    );
  } finally {
    await first.release();
    await rm(directory, { recursive: true, force: true });
  }
});

test('concurrent acquisition in one process elects exactly one owner', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'colorful-code-lock-race-'));
  const results = await Promise.allSettled(
    Array.from({ length: 12 }, () =>
      DataDirectoryInstanceLock.acquire(directory),
    ),
  );
  const winners = results.filter(
    (result): result is PromiseFulfilledResult<DataDirectoryInstanceLock> =>
      result.status === 'fulfilled',
  );

  try {
    assert.equal(winners.length, 1);
    for (const result of results) {
      if (result.status === 'rejected') {
        assert.ok(result.reason instanceof DataDirectoryLockConflictError);
      }
    }
  } finally {
    await Promise.all(winners.map(({ value }) => value.release()));
    await rm(directory, { recursive: true, force: true });
  }
});

test('different data directories can be locked at the same time', async () => {
  const root = await mkdtemp(join(tmpdir(), 'colorful-code-lock-dirs-'));
  const [first, second] = await Promise.all([
    DataDirectoryInstanceLock.acquire(join(root, 'first')),
    DataDirectoryInstanceLock.acquire(join(root, 'second')),
  ]);

  try {
    assert.ok(first);
    assert.ok(second);
  } finally {
    await Promise.all([first.release(), second.release()]);
    await rm(root, { recursive: true, force: true });
  }
});

test('lock initialization uses a fixed header write without startup VACUUM', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'colorful-code-lock-init-'));
  const lock = await DataDirectoryInstanceLock.acquire(directory);
  await lock.release();
  const database = new Database(join(directory, LOCK_FILE_NAME), {
    readonly: true,
  });
  try {
    assert.equal(
      database
        .query<{ application_id: number }, []>('PRAGMA application_id')
        .get()?.application_id,
      LOCK_APPLICATION_ID,
    );
    assert.deepEqual(
      database.query('SELECT name FROM sqlite_master').all(),
      [],
    );
  } finally {
    database.close(true);
    await rm(directory, { recursive: true, force: true });
  }
});

test('rejects a pre-positioned symbolic-link lock without touching its target', async () => {
  const root = await mkdtemp(join(tmpdir(), 'colorful-code-lock-symlink-'));
  const directory = join(root, 'data');
  await DataDirectoryInstanceLock.acquire(directory).then((lock) =>
    lock.release(),
  );
  const lockPath = join(directory, LOCK_FILE_NAME);
  const targetPath = join(root, 'target.sqlite');
  const target = new Database(targetPath, { create: true, readwrite: true });
  target.exec('PRAGMA application_id = 73');
  target.close(true);
  await rm(lockPath);
  await symlink(targetPath, lockPath);

  try {
    await assert.rejects(
      DataDirectoryInstanceLock.acquire(directory),
      /symbolic link/i,
    );
    const untouched = new Database(targetPath, { readonly: true });
    try {
      assert.equal(
        untouched
          .query<{ application_id: number }, []>('PRAGMA application_id')
          .get()?.application_id,
        73,
      );
    } finally {
      untouched.close(true);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects non-regular and multiply-linked lock files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'colorful-code-lock-kind-'));
  const directory = join(root, 'data');
  await DataDirectoryInstanceLock.acquire(directory).then((lock) =>
    lock.release(),
  );
  const lockPath = join(directory, LOCK_FILE_NAME);

  try {
    await rm(lockPath);
    await Bun.write(lockPath, 'not sqlite');
    await link(lockPath, join(root, 'extra-link'));
    await assert.rejects(
      DataDirectoryInstanceLock.acquire(directory),
      /exactly one filesystem link/i,
    );

    await rm(join(root, 'extra-link'));
    await rm(lockPath);
    await mkdir(lockPath);
    await assert.rejects(
      DataDirectoryInstanceLock.acquire(directory),
      /regular file/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects a lock database owned by another application', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'colorful-code-lock-app-'));
  const lockPath = join(directory, LOCK_FILE_NAME);
  const foreign = new Database(lockPath, { create: true, readwrite: true });
  foreign.exec('PRAGMA application_id = 73');
  foreign.close(true);

  try {
    await assert.rejects(
      DataDirectoryInstanceLock.acquire(directory),
      /unexpected SQLite application_id 73/i,
    );
    const reopened = new Database(lockPath, { readonly: true });
    try {
      assert.equal(
        reopened
          .query<{ application_id: number }, []>('PRAGMA application_id')
          .get()?.application_id,
        73,
      );
    } finally {
      reopened.close(true);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('creates private directories and lock files without chmodding a private existing directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'colorful-code-lock-mode-'));
  const freshDirectory = join(root, 'fresh');
  const fresh = await DataDirectoryInstanceLock.acquire(freshDirectory);
  await fresh.release();

  const existingDirectory = join(root, 'existing');
  await mkdir(existingDirectory);
  await chmod(existingDirectory, 0o700);
  const existing = await DataDirectoryInstanceLock.acquire(existingDirectory);
  await existing.release();

  try {
    assert.equal((await stat(freshDirectory)).mode & 0o777, 0o700);
    assert.equal(
      (await stat(join(freshDirectory, LOCK_FILE_NAME))).mode & 0o777,
      0o600,
    );
    assert.equal((await stat(existingDirectory)).mode & 0o777, 0o700);
    assert.equal(
      (await stat(join(existingDirectory, LOCK_FILE_NAME))).mode & 0o777,
      0o600,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('tightens an existing legacy data directory before acquiring its lock', async () => {
  const directory = await mkdtemp(
    join(tmpdir(), 'colorful-code-lock-insecure-directory-'),
  );
  await chmod(directory, 0o755);

  let lock: DataDirectoryInstanceLock | undefined;
  try {
    lock = await DataDirectoryInstanceLock.acquire(directory);
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
  } finally {
    await lock?.release();
    await chmod(directory, 0o700);
    await rm(directory, { recursive: true, force: true });
  }
});

test('detects runtime lock-path replacement and keeps a second owner out', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'colorful-code-lock-swap-'));
  const first = await DataDirectoryInstanceLock.acquire(directory);
  const lockPath = join(directory, LOCK_FILE_NAME);
  const displacedPath = join(directory, 'displaced-lock');
  await rename(lockPath, displacedPath);
  const replacement = new Database(lockPath, { create: true, readwrite: true });
  replacement.close(true);
  const secondDaemon = spawnHolder(directory);

  try {
    await assert.rejects(first.assertHealthy(), /identity changed/i);
    await assert.rejects(
      DataDirectoryInstanceLock.acquire(directory),
      (error: unknown) => error instanceof DataDirectoryLockConflictError,
    );
    const status = await readJsonLine(secondDaemon.stdout);
    assert.equal(status.status, 'conflict');
    assert.equal(await secondDaemon.exited, 2);
    await assert.rejects(first.release(), /identity changed/i);
  } finally {
    await first.release();
    await terminateHolder(secondDaemon);
    await rm(directory, { recursive: true, force: true });
  }
});

test('release is concurrent-safe, idempotent, and permits immediate reacquisition', async () => {
  const directory = await mkdtemp(
    join(tmpdir(), 'colorful-code-lock-release-'),
  );
  const first = await DataDirectoryInstanceLock.acquire(directory);
  let second: DataDirectoryInstanceLock | undefined;

  try {
    await Promise.all([first.release(), first.release(), first.release()]);
    await first.release();
    second = await DataDirectoryInstanceLock.acquire(directory);
  } finally {
    await second?.release();
    await first.release();
    await rm(directory, { recursive: true, force: true });
  }
});

test('release still closes the SQLite handle when rollback fails', async () => {
  const directory = await mkdtemp(
    join(tmpdir(), 'colorful-code-lock-release-failure-'),
  );
  const lock = await DataDirectoryInstanceLock.acquire(directory);
  const database = lockDatabase(lock);
  const originalExec = database.exec.bind(database);
  const rollbackError = new Error('injected rollback failure');
  database.exec = () => {
    throw rollbackError;
  };
  let replacement: DataDirectoryInstanceLock | undefined;

  try {
    await assert.rejects(lock.release(), rollbackError);
    replacement = await DataDirectoryInstanceLock.acquire(directory);
    await lock.release();
  } finally {
    database.exec = originalExec;
    await replacement?.release();
    await rm(directory, { recursive: true, force: true });
  }
});

test('release aggregates rollback and close failures after attempting both', async () => {
  const directory = await mkdtemp(
    join(tmpdir(), 'colorful-code-lock-release-errors-'),
  );
  const lock = await DataDirectoryInstanceLock.acquire(directory);
  const database = lockDatabase(lock);
  const originalExec = database.exec.bind(database);
  const originalClose = database.close.bind(database);
  const rollbackError = new Error('injected rollback failure');
  const closeError = new Error('injected close failure');
  database.exec = () => {
    throw rollbackError;
  };
  database.close = () => {
    throw closeError;
  };

  try {
    await assert.rejects(lock.release(), (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [rollbackError, closeError]);
      return true;
    });
  } finally {
    database.exec = originalExec;
    database.close = originalClose;
    database.exec('ROLLBACK');
    database.close(true);
    await rm(directory, { recursive: true, force: true });
  }
});

test('the dedicated lock database contains no schema or sensitive metadata', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'colorful-code-lock-data-'));
  const secret = `instance-lock-secret-${crypto.randomUUID()}`;
  process.env.INSTANCE_LOCK_TEST_SECRET = secret;
  const lock = await DataDirectoryInstanceLock.acquire(directory);
  let released = false;

  try {
    const lockPath = join(await realpath(directory), LOCK_FILE_NAME);
    assert.equal((await stat(lockPath)).isFile(), true);

    for (const entry of await readdir(directory)) {
      if (!entry.startsWith(LOCK_FILE_NAME)) continue;
      const bytes = await readFile(join(directory, entry));
      assert.equal(bytes.includes(Buffer.from(secret)), false);
    }

    await lock.release();
    released = true;
    const database = new Database(lockPath, { readonly: true });
    try {
      const objects = database
        .query('SELECT name FROM sqlite_master')
        .all() as Array<{ name: string }>;
      assert.deepEqual(objects, []);
    } finally {
      database.close();
    }
  } finally {
    delete process.env.INSTANCE_LOCK_TEST_SECRET;
    if (!released) await lock.release();
    await rm(directory, { recursive: true, force: true });
  }
});

test('real daemon processes starting together elect one winner', async () => {
  const directory = await mkdtemp(
    join(tmpdir(), 'colorful-code-lock-process-race-'),
  );
  const holders = Array.from({ length: 6 }, () => spawnHolder(directory));

  try {
    const statuses = await Promise.all(
      holders.map((holder) => readJsonLine(holder.stdout)),
    );
    const ready = statuses.filter((status) => status.status === 'ready');
    const conflicts = statuses.filter((status) => status.status === 'conflict');
    assert.equal(ready.length, 1, JSON.stringify(statuses));
    assert.equal(conflicts.length, holders.length - 1);
    for (const [index, status] of statuses.entries()) {
      if (status.status !== 'conflict') continue;
      assert.match(
        String(status.message),
        /Another Colorful Code daemon is already using this data directory/,
      );
      assert.equal(await holders[index]!.exited, 2);
      assert.match(
        await new Response(holders[index]!.stderr).text(),
        /Another Colorful Code daemon is already using this data directory/,
      );
    }
  } finally {
    await Promise.all(holders.map(terminateHolder));
    await rm(directory, { recursive: true, force: true });
  }
});

test('graceful holder shutdown permits immediate reacquisition', async () => {
  const directory = await mkdtemp(
    join(tmpdir(), 'colorful-code-lock-process-release-'),
  );
  const holder = spawnHolder(directory);
  let replacement: DataDirectoryInstanceLock | undefined;

  try {
    assert.equal((await readJsonLine(holder.stdout)).status, 'ready');
    holder.kill('SIGTERM');
    assert.equal(await holder.exited, 0);
    replacement = await DataDirectoryInstanceLock.acquire(directory);
  } finally {
    await replacement?.release();
    await terminateHolder(holder);
    await rm(directory, { recursive: true, force: true });
  }
});

test('SIGKILL releases the OS lock without a stale wait', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'colorful-code-lock-killed-'));
  const holder = spawnHolder(directory);
  let replacement: DataDirectoryInstanceLock | undefined;

  try {
    assert.equal((await readJsonLine(holder.stdout)).status, 'ready');
    holder.kill('SIGKILL');
    await holder.exited;
    replacement = await DataDirectoryInstanceLock.acquire(directory);
  } finally {
    await replacement?.release();
    await terminateHolder(holder);
    await rm(directory, { recursive: true, force: true });
  }
});

type HolderProcess = ReturnType<typeof spawnHolder>;

interface TestDatabaseHandle {
  close(throwOnError?: boolean): void;
  exec(sql: string): unknown;
}

function lockDatabase(lock: DataDirectoryInstanceLock): TestDatabaseHandle {
  return (lock as unknown as { database: TestDatabaseHandle }).database;
}

function spawnHolder(dataDirectory: string) {
  return Bun.spawn(['bun', HOLDER_FIXTURE, dataDirectory], {
    cwd: join(import.meta.dir, '..'),
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
}

async function terminateHolder(holder: HolderProcess): Promise<void> {
  if (holder.exitCode !== null) return;
  holder.kill('SIGTERM');
  await holder.exited;
}

async function readJsonLine(
  stream: ReadableStream<Uint8Array>,
): Promise<Record<string, unknown>> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) throw new Error(`Process exited before a JSON line: ${buffer}`);
      buffer += decoder.decode(value, { stream: true });
      const newline = buffer.indexOf('\n');
      if (newline >= 0) {
        return JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>;
      }
    }
  } finally {
    reader.releaseLock();
  }
}
