import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Database } from 'bun:sqlite';
import {
  createMigrationBackup,
  quarantineDatabase,
  restoreMigrationBackup,
  verifyDatabase,
} from '../src/persistence/migration-backup-recovery';

function createRestorableBackup(directory: string) {
  const sourceDatabasePath = join(directory, 'colorful.sqlite');
  const source = new Database(sourceDatabasePath, { create: true });
  source.exec(
    "CREATE TABLE notes (body TEXT NOT NULL); INSERT INTO notes VALUES ('old content')",
  );
  const backup = createMigrationBackup({
    database: source,
    sourceDatabasePath,
    sourceSchemaVersion: 1,
    targetSchemaVersion: 2,
    now: () => new Date('2026-07-14T10:00:00.000Z'),
    randomId: () => 'backup',
  });
  source.close();
  return { backup, sourceDatabasePath };
}

test('restoreMigrationBackup restores verified old content after quarantining main and sidecars', () => {
  const directory = mkdtempSync(join(tmpdir(), 'migration-restore-'));
  try {
    const { backup, sourceDatabasePath } = createRestorableBackup(directory);
    writeFileSync(`${sourceDatabasePath}-wal`, 'wal sentinel');
    writeFileSync(`${sourceDatabasePath}-shm`, 'shm sentinel');
    const quarantined = quarantineDatabase({
      databasePath: sourceDatabasePath,
      now: () => new Date('2026-07-14T11:00:00.000Z'),
      randomId: () => 'old',
    });

    restoreMigrationBackup({
      backup,
      targetDatabasePath: sourceDatabasePath,
      quarantine: quarantined,
      randomId: () => 'restore',
    });

    assert.equal(existsSync(`${sourceDatabasePath}-wal`), false);
    assert.equal(existsSync(`${sourceDatabasePath}-shm`), false);
    assert.equal(readFileSync(quarantined.walPath!, 'utf8'), 'wal sentinel');
    assert.equal(readFileSync(quarantined.shmPath!, 'utf8'), 'shm sentinel');
    const restored = new Database(sourceDatabasePath, { readonly: true });
    try {
      assert.equal(
        restored.query<{ body: string }, []>('SELECT body FROM notes').get()
          ?.body,
        'old content',
      );
      assert.deepEqual(
        restored
          .query<{ integrity_check: string }, []>('PRAGMA integrity_check')
          .all(),
        [{ integrity_check: 'ok' }],
      );
      assert.equal(restored.query('PRAGMA foreign_key_check').all().length, 0);
    } finally {
      restored.close();
    }
    assert.equal(existsSync(join(directory, '.restore-restore.tmp')), false);
    assert.equal(statSync(sourceDatabasePath).mode & 0o777, 0o600);
    assert.equal(statSync(backup.directoryPath).mode & 0o777, 0o700);
    assert.equal(statSync(backup.databasePath).mode & 0o777, 0o600);
    assert.equal(statSync(backup.manifestPath).mode & 0o777, 0o600);
    assert.equal(statSync(quarantined.directoryPath).mode & 0o777, 0o700);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('quarantine durability synchronizes both source and destination directories', () => {
  const source = readFileSync(
    join(import.meta.dir, '../src/persistence/migration-backup-recovery.ts'),
    'utf8',
  );
  const quarantineBody = source.slice(
    source.indexOf('export function quarantineDatabase'),
    source.indexOf('export interface RestoreMigrationBackupOptions'),
  );
  assert.match(quarantineBody, /syncPath\(dirname\(sourcePath\)\)/);

  const failedPublishBody = source.slice(
    source.indexOf('function quarantinePublishedFailure'),
    source.indexOf('export function restoreMigrationBackup'),
  );
  assert.match(failedPublishBody, /syncPath\(dirname\(targetPath\)\)/);
});

test('restoreMigrationBackup rereads manifest and rejects tampered backup bytes', () => {
  const directory = mkdtempSync(join(tmpdir(), 'migration-restore-tamper-'));
  try {
    const { backup, sourceDatabasePath } = createRestorableBackup(directory);
    rmSync(sourceDatabasePath);
    const bytes = readFileSync(backup.databasePath);
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 0xff;
    writeFileSync(backup.databasePath, bytes);

    assert.throws(
      () =>
        restoreMigrationBackup({
          backup,
          targetDatabasePath: sourceDatabasePath,
        }),
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'backup_invalid',
    );
    assert.equal(existsSync(sourceDatabasePath), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('restoreMigrationBackup rejects backup replacement between verification and open', () => {
  const directory = mkdtempSync(join(tmpdir(), 'migration-restore-open-swap-'));
  try {
    const { backup, sourceDatabasePath } = createRestorableBackup(directory);
    rmSync(sourceDatabasePath);
    const verifiedPath = `${backup.databasePath}.verified`;
    class ReplacingDatabase {
      constructor(
        path: string,
        options: ConstructorParameters<typeof Database>[1],
      ) {
        renameSync(path, verifiedPath);
        const replacement = new Database(path, {
          create: true,
          readwrite: true,
        });
        replacement.exec(
          "CREATE TABLE notes(body TEXT NOT NULL); INSERT INTO notes VALUES ('attacker content')",
        );
        replacement.close(true);
        return new Database(path, options);
      }
    }

    assert.throws(
      () =>
        restoreMigrationBackup({
          backup,
          targetDatabasePath: sourceDatabasePath,
          randomId: () => 'open-swap',
          operations: {
            openDatabase: ReplacingDatabase as unknown as typeof Database,
          },
        }),
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'recovery_failed',
    );
    assert.equal(existsSync(sourceDatabasePath), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('restoreMigrationBackup rejects invalid disk manifest fields without trusting memory', () => {
  const invalidMutations: Array<{
    name: string;
    mutate: (manifest: Record<string, unknown>) => void;
  }> = [
    { name: 'extra field', mutate: (manifest) => void (manifest.extra = true) },
    {
      name: 'missing field',
      mutate: (manifest) => void delete manifest.sha256,
    },
    {
      name: 'format version',
      mutate: (manifest) => void (manifest.formatVersion = 2),
    },
    {
      name: 'relative source path',
      mutate: (manifest) => void (manifest.sourceDatabaseFile = 'other.sqlite'),
    },
    {
      name: 'non-string source path',
      mutate: (manifest) => void (manifest.sourceDatabaseFile = 42),
    },
    {
      name: 'checksum',
      mutate: (manifest) => void (manifest.sha256 = 'A'.repeat(64)),
    },
    { name: 'size', mutate: (manifest) => void (manifest.sizeBytes = -1) },
    {
      name: 'database path',
      mutate: (manifest) => void (manifest.databaseFile = '../outside.sqlite'),
    },
    {
      name: 'source version',
      mutate: (manifest) => void (manifest.sourceSchemaVersion = 1.5),
    },
    {
      name: 'target version',
      mutate: (manifest) => void (manifest.targetSchemaVersion = -1),
    },
    {
      name: 'created at',
      mutate: (manifest) => void (manifest.createdAt = '2026-07-14'),
    },
    {
      name: 'integrity',
      mutate: (manifest) => void (manifest.integrityCheck = 'bad'),
    },
    {
      name: 'foreign keys',
      mutate: (manifest) => void (manifest.foreignKeyViolations = 1),
    },
  ];

  for (const [index, { name, mutate }] of invalidMutations.entries()) {
    const directory = mkdtempSync(
      join(tmpdir(), `migration-manifest-${index}-`),
    );
    try {
      const { backup, sourceDatabasePath } = createRestorableBackup(directory);
      rmSync(sourceDatabasePath);
      const manifest = JSON.parse(readFileSync(backup.manifestPath, 'utf8'));
      mutate(manifest);
      writeFileSync(backup.manifestPath, JSON.stringify(manifest));
      assert.throws(
        () =>
          restoreMigrationBackup({
            backup,
            targetDatabasePath: sourceDatabasePath,
          }),
        (error: unknown) =>
          error instanceof Error &&
          'code' in error &&
          error.code === 'backup_invalid',
        name,
      );
      assert.equal(existsSync(sourceDatabasePath), false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test('restoreMigrationBackup refuses an existing target and preserves its bytes', () => {
  const directory = mkdtempSync(join(tmpdir(), 'migration-restore-refuse-'));
  try {
    const { backup, sourceDatabasePath } = createRestorableBackup(directory);
    writeFileSync(sourceDatabasePath, 'current database');
    assert.throws(
      () =>
        restoreMigrationBackup({
          backup,
          targetDatabasePath: sourceDatabasePath,
        }),
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'recovery_refused',
    );
    assert.equal(readFileSync(sourceDatabasePath, 'utf8'), 'current database');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('restoreMigrationBackup refuses existing WAL, SHM, and dangling target entries', () => {
  for (const suffix of ['', '-wal', '-shm']) {
    const directory = mkdtempSync(
      join(tmpdir(), `migration-restore-sidecar-${suffix || 'main'}-`),
    );
    try {
      const { backup, sourceDatabasePath } = createRestorableBackup(directory);
      rmSync(sourceDatabasePath);
      const occupiedPath = `${sourceDatabasePath}${suffix}`;
      symlinkSync(join(directory, 'missing-target'), occupiedPath);

      assert.throws(
        () =>
          restoreMigrationBackup({
            backup,
            targetDatabasePath: sourceDatabasePath,
          }),
        (error: unknown) =>
          error instanceof Error &&
          'code' in error &&
          error.code === 'recovery_refused',
        suffix || 'main',
      );
      assert.equal(lstatSync(occupiedPath).isSymbolicLink(), true);
      assert.equal(existsSync(sourceDatabasePath), false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test('restoreMigrationBackup refuses a repeated restore without changing restored content', () => {
  const directory = mkdtempSync(join(tmpdir(), 'migration-restore-repeat-'));
  try {
    const { backup, sourceDatabasePath } = createRestorableBackup(directory);
    rmSync(sourceDatabasePath);
    restoreMigrationBackup({
      backup,
      targetDatabasePath: sourceDatabasePath,
      randomId: () => 'first',
    });
    const restored = new Database(sourceDatabasePath);
    restored.query('INSERT INTO notes VALUES (?)').run('after first restore');
    restored.close();

    assert.throws(
      () =>
        restoreMigrationBackup({
          backup,
          targetDatabasePath: sourceDatabasePath,
          randomId: () => 'second',
        }),
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'recovery_refused',
    );
    const reopened = new Database(sourceDatabasePath, { readonly: true });
    try {
      assert.deepEqual(
        reopened
          .query<{ body: string }, []>('SELECT body FROM notes ORDER BY rowid')
          .all()
          .map((row) => row.body),
        ['old content', 'after first restore'],
      );
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('restoreMigrationBackup cleans its reservation when opening the backup fails before serialization', () => {
  const directory = mkdtempSync(join(tmpdir(), 'migration-restore-open-fail-'));
  try {
    const { backup, sourceDatabasePath } = createRestorableBackup(directory);
    rmSync(sourceDatabasePath);
    class FailingDatabase {
      constructor() {
        throw new Error('injected open failure');
      }
    }
    assert.throws(
      () =>
        restoreMigrationBackup({
          backup,
          targetDatabasePath: sourceDatabasePath,
          randomId: () => 'open-fail',
          operations: { openDatabase: FailingDatabase as typeof Database },
        }),
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'recovery_failed',
    );
    assert.equal(existsSync(sourceDatabasePath), false);
    assert.equal(existsSync(join(directory, '.restore-open-fail.tmp')), false);
    assert.equal(
      existsSync(join(directory, '.restore-open-fail.reserve')),
      false,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('restoreMigrationBackup removes only its temporary database when publish link fails', () => {
  const directory = mkdtempSync(
    join(tmpdir(), 'migration-restore-rename-fail-'),
  );
  try {
    const { backup, sourceDatabasePath } = createRestorableBackup(directory);
    rmSync(sourceDatabasePath);
    const unrelated = join(directory, '.restore-someone-else.tmp');
    writeFileSync(unrelated, 'keep');
    assert.throws(
      () =>
        restoreMigrationBackup({
          backup,
          targetDatabasePath: sourceDatabasePath,
          randomId: () => 'rename-fail',
          operations: {
            link: () => {
              throw new Error('injected link failure');
            },
          },
        }),
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'recovery_failed',
    );
    assert.equal(existsSync(sourceDatabasePath), false);
    assert.equal(
      existsSync(join(directory, '.restore-rename-fail.tmp')),
      false,
    );
    assert.equal(readFileSync(unrelated, 'utf8'), 'keep');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('restoreMigrationBackup atomically refuses a target created at publish time', () => {
  const directory = mkdtempSync(
    join(tmpdir(), 'migration-restore-publish-race-'),
  );
  try {
    const { backup, sourceDatabasePath } = createRestorableBackup(directory);
    rmSync(sourceDatabasePath);

    assert.throws(
      () =>
        restoreMigrationBackup({
          backup,
          targetDatabasePath: sourceDatabasePath,
          randomId: () => 'publish-race',
          operations: {
            link: (existingPath, newPath) => {
              writeFileSync(newPath, 'new business database');
              linkSync(existingPath, newPath);
            },
          },
        }),
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'recovery_refused',
    );
    assert.equal(
      readFileSync(sourceDatabasePath, 'utf8'),
      'new business database',
    );
    assert.equal(
      existsSync(join(directory, '.restore-publish-race.tmp')),
      false,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('restoreMigrationBackup refuses sidecars created immediately before publish', () => {
  for (const suffix of ['-wal', '-shm']) {
    const directory = mkdtempSync(
      join(tmpdir(), `migration-restore-publish${suffix}-`),
    );
    try {
      const { backup, sourceDatabasePath } = createRestorableBackup(directory);
      rmSync(sourceDatabasePath);
      const sidecarPath = `${sourceDatabasePath}${suffix}`;

      assert.throws(
        () =>
          restoreMigrationBackup({
            backup,
            targetDatabasePath: sourceDatabasePath,
            randomId: () => `publish${suffix}`,
            operations: {
              beforePublish: () => writeFileSync(sidecarPath, 'new sidecar'),
            },
          }),
        (error: unknown) =>
          error instanceof Error &&
          'code' in error &&
          error.code === 'recovery_refused',
        suffix,
      );
      assert.equal(existsSync(sourceDatabasePath), false);
      assert.equal(readFileSync(sidecarPath, 'utf8'), 'new sidecar');
      assert.equal(
        existsSync(join(directory, `.restore-publish${suffix}.tmp`)),
        false,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test('restoreMigrationBackup cleans staging when a sidecar appears just after publish', () => {
  const directory = mkdtempSync(
    join(tmpdir(), 'migration-restore-post-publish-sidecar-'),
  );
  try {
    const { backup, sourceDatabasePath } = createRestorableBackup(directory);
    rmSync(sourceDatabasePath);
    const quarantinePath = join(directory, 'existing-quarantine');
    mkdirSync(quarantinePath);

    assert.throws(
      () =>
        restoreMigrationBackup({
          backup,
          targetDatabasePath: sourceDatabasePath,
          quarantine: { directoryPath: quarantinePath },
          randomId: () => 'post-publish-sidecar',
          operations: {
            link: (existingPath, newPath) => {
              linkSync(existingPath, newPath);
              writeFileSync(`${newPath}-wal`, 'racing sidecar');
            },
          },
        }),
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'recovery_failed',
    );
    assert.equal(existsSync(sourceDatabasePath), false);
    assert.equal(
      existsSync(join(directory, '.restore-post-publish-sidecar.tmp')),
      false,
    );
    assert.equal(
      readFileSync(
        join(
          quarantinePath,
          'restore-failure-post-publish-sidecar',
          'colorful.sqlite-wal',
        ),
        'utf8',
      ),
      'racing sidecar',
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('restoreMigrationBackup quarantines a published target when final verification fails', () => {
  const directory = mkdtempSync(
    join(tmpdir(), 'migration-restore-verify-fail-'),
  );
  try {
    const { backup, sourceDatabasePath } = createRestorableBackup(directory);
    rmSync(sourceDatabasePath);
    const quarantinePath = join(directory, 'existing-quarantine');
    mkdirSync(quarantinePath);
    let verifies = 0;
    assert.throws(
      () =>
        restoreMigrationBackup({
          backup,
          targetDatabasePath: sourceDatabasePath,
          quarantine: { directoryPath: quarantinePath },
          randomId: () => 'verify-fail',
          operations: {
            verify: (path) => {
              verifies += 1;
              if (verifies === 3)
                throw new Error('injected final verify failure');
              verifyDatabase(path);
            },
          },
        }),
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'recovery_failed',
    );
    assert.equal(verifies, 3);
    assert.equal(existsSync(sourceDatabasePath), false);
    const failedTarget = join(
      quarantinePath,
      'restore-failure-verify-fail',
      'colorful.sqlite',
    );
    assert.equal(existsSync(failedTarget), true);
    verifyDatabase(failedTarget);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('restoreMigrationBackup handles quoted target paths and rejects unsafe restore ids', () => {
  const directory = mkdtempSync(join(tmpdir(), "migration-restore-'quoted-"));
  try {
    const { backup, sourceDatabasePath } = createRestorableBackup(directory);
    rmSync(sourceDatabasePath);
    assert.throws(
      () =>
        restoreMigrationBackup({
          backup,
          targetDatabasePath: sourceDatabasePath,
          randomId: () => '../unsafe',
        }),
      /safe single path segment/,
    );
    restoreMigrationBackup({
      backup,
      targetDatabasePath: sourceDatabasePath,
      randomId: () => 'safe-id',
    });
    verifyDatabase(sourceDatabasePath);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('restoreMigrationBackup cleans temporary state after snapshot serialization failure', () => {
  const directory = mkdtempSync(join(tmpdir(), 'migration-restore-partial-'));
  try {
    const { backup, sourceDatabasePath } = createRestorableBackup(directory);
    rmSync(sourceDatabasePath);
    const temporaryDirectoryPath = join(directory, '.restore-partial.tmp');
    const temporaryPath = join(temporaryDirectoryPath, 'colorful-code.db');
    class PartiallyFailingDatabase {
      query() {
        return {
          get: () => ({ page_count: 1, page_size: 4096 }),
        };
      }
      serialize() {
        writeFileSync(temporaryPath, 'partial database');
        throw new Error('injected serialization failure');
      }
      close() {}
    }
    assert.throws(
      () =>
        restoreMigrationBackup({
          backup,
          targetDatabasePath: sourceDatabasePath,
          randomId: () => 'partial',
          operations: {
            openDatabase:
              PartiallyFailingDatabase as unknown as typeof Database,
          },
        }),
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'recovery_failed',
    );
    assert.equal(existsSync(temporaryDirectoryPath), false);
    assert.equal(existsSync(sourceDatabasePath), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('restoreMigrationBackup rejects a backup database replaced by a symbolic link', () => {
  const directory = mkdtempSync(join(tmpdir(), 'migration-restore-symlink-'));
  try {
    const { backup, sourceDatabasePath } = createRestorableBackup(directory);
    rmSync(sourceDatabasePath);
    const replacementPath = join(directory, 'replacement.sqlite');
    copyFileSync(backup.databasePath, replacementPath);
    rmSync(backup.databasePath);
    symlinkSync(replacementPath, backup.databasePath);

    assert.throws(
      () =>
        restoreMigrationBackup({
          backup,
          targetDatabasePath: sourceDatabasePath,
        }),
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'backup_invalid',
    );
    assert.equal(existsSync(sourceDatabasePath), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('restoreMigrationBackup rejects a hard-linked backup database', () => {
  const directory = mkdtempSync(join(tmpdir(), 'migration-restore-hardlink-'));
  try {
    const { backup, sourceDatabasePath } = createRestorableBackup(directory);
    rmSync(sourceDatabasePath);
    linkSync(backup.databasePath, join(directory, 'backup-alias.sqlite'));

    assert.throws(
      () =>
        restoreMigrationBackup({
          backup,
          targetDatabasePath: sourceDatabasePath,
          randomId: () => 'hardlink',
        }),
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'backup_invalid',
    );
    assert.equal(existsSync(sourceDatabasePath), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('restoreMigrationBackup reports a missing disk manifest as backup_invalid', () => {
  const directory = mkdtempSync(
    join(tmpdir(), 'migration-restore-manifest-missing-'),
  );
  try {
    const { backup, sourceDatabasePath } = createRestorableBackup(directory);
    rmSync(sourceDatabasePath);
    rmSync(backup.manifestPath);
    assert.throws(
      () =>
        restoreMigrationBackup({
          backup,
          targetDatabasePath: sourceDatabasePath,
        }),
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'backup_invalid',
    );
    assert.equal(existsSync(sourceDatabasePath), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('quarantineDatabase moves main, WAL, and SHM files without altering bytes', () => {
  const directory = mkdtempSync(join(tmpdir(), 'migration-quarantine-'));
  const databasePath = join(directory, 'source.sqlite');
  const files = [databasePath, `${databasePath}-wal`, `${databasePath}-shm`];
  const contents = ['main sentinel', 'wal sentinel', 'shm sentinel'];

  try {
    files.forEach((path, index) => writeFileSync(path, contents[index]!));
    const quarantined = quarantineDatabase({
      databasePath,
      now: () => new Date('2026-07-14T10:11:12.013Z'),
      randomId: () => 'fixed-id',
    });

    assert.equal(
      quarantined.directoryPath,
      join(directory, 'migration-quarantine', '20260714T101112013Z-fixed-id'),
    );
    const moved = [
      quarantined.databasePath,
      quarantined.walPath,
      quarantined.shmPath,
    ];
    files.forEach((path) => assert.equal(existsSync(path), false));
    moved.forEach((path, index) => {
      assert.ok(path);
      assert.equal(readFileSync(path, 'utf8'), contents[index]);
      assert.equal(statSync(path).mode & 0o777, 0o600);
    });
    assert.equal(statSync(quarantined.directoryPath).mode & 0o777, 0o700);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('quarantineDatabase moves a dangling sidecar entry out of the business path', () => {
  const directory = mkdtempSync(
    join(tmpdir(), 'migration-quarantine-dangling-'),
  );
  const databasePath = join(directory, 'source.sqlite');
  const walPath = `${databasePath}-wal`;
  try {
    writeFileSync(databasePath, 'main sentinel');
    symlinkSync(join(directory, 'missing-wal-target'), walPath);
    const quarantined = quarantineDatabase({
      databasePath,
      now: () => new Date('2026-07-14T12:00:00.000Z'),
      randomId: () => 'dangling',
    });

    assert.throws(() => lstatSync(walPath), { code: 'ENOENT' });
    assert.ok(quarantined.walPath);
    assert.equal(lstatSync(quarantined.walPath).isSymbolicLink(), true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('quarantineDatabase fails closed when the main database is absent', () => {
  const directory = mkdtempSync(
    join(tmpdir(), 'migration-quarantine-missing-'),
  );
  const databasePath = join(directory, 'missing.sqlite');
  try {
    assert.throws(
      () => quarantineDatabase({ databasePath }),
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'quarantine_failed',
    );
    assert.equal(existsSync(join(directory, 'migration-quarantine')), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('quarantineDatabase rejects a directory in place of the main database', () => {
  const directory = mkdtempSync(
    join(tmpdir(), 'migration-quarantine-directory-'),
  );
  const databasePath = join(directory, 'not-a-database.sqlite');
  mkdirSync(databasePath);
  try {
    assert.throws(
      () => quarantineDatabase({ databasePath }),
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'quarantine_failed',
    );
    assert.equal(existsSync(databasePath), true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('createMigrationBackup includes uncheckpointed WAL commits and writes a verified manifest', () => {
  const directory = mkdtempSync(join(tmpdir(), 'migration-backup-'));
  const sourceDatabasePath = join(directory, 'source.sqlite');
  const source = new Database(sourceDatabasePath, { create: true });

  try {
    source.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA wal_autocheckpoint = 0;
      CREATE TABLE messages (body TEXT NOT NULL);
      INSERT INTO messages VALUES ('latest committed value');
    `);
    assert.equal(
      source.query<{ journal_mode: string }, []>('PRAGMA journal_mode').get()
        ?.journal_mode,
      'wal',
    );
    assert.equal(existsSync(`${sourceDatabasePath}-wal`), true);
    assert.ok(statSync(`${sourceDatabasePath}-wal`).size > 0);

    const mainFileOnlyPath = join(directory, 'main-file-only.sqlite');
    copyFileSync(sourceDatabasePath, mainFileOnlyPath);
    const mainFileOnly = new Database(mainFileOnlyPath, { readonly: true });
    let mainFileOnlyHasLatestCommit = false;
    try {
      mainFileOnlyHasLatestCommit =
        mainFileOnly
          .query<{ body: string }, []>('SELECT body FROM messages')
          .get()?.body === 'latest committed value';
    } catch {
      // The schema itself may still only exist in WAL, which also proves the premise.
    } finally {
      mainFileOnly.close();
    }
    assert.equal(mainFileOnlyHasLatestCommit, false);

    const backup = createMigrationBackup({
      database: source,
      sourceDatabasePath,
      sourceSchemaVersion: 3,
      targetSchemaVersion: 4,
      now: () => new Date('2026-07-14T01:02:03.004Z'),
      randomId: () => 'fixed-id',
    });

    const snapshot = new Database(backup.databasePath, { readonly: true });
    try {
      assert.equal(
        snapshot.query<{ body: string }, []>('SELECT body FROM messages').get()
          ?.body,
        'latest committed value',
      );
    } finally {
      snapshot.close();
    }

    const databaseBytes = readFileSync(backup.databasePath);
    const manifestFile = JSON.parse(readFileSync(backup.manifestPath, 'utf8'));
    assert.deepEqual(manifestFile, backup.manifest);
    assert.deepEqual(backup.manifest, {
      formatVersion: 1,
      sourceDatabaseFile: 'source.sqlite',
      sourceSchemaVersion: 3,
      targetSchemaVersion: 4,
      createdAt: '2026-07-14T01:02:03.004Z',
      databaseFile: 'colorful-code.db',
      sizeBytes: databaseBytes.byteLength,
      sha256: createHash('sha256').update(databaseBytes).digest('hex'),
      integrityCheck: 'ok',
      foreignKeyViolations: 0,
    });
    assert.equal(statSync(join(directory, 'backups')).mode & 0o777, 0o700);
    assert.equal(statSync(backup.directoryPath).mode & 0o777, 0o700);
    assert.equal(statSync(backup.databasePath).mode & 0o777, 0o600);
    assert.equal(statSync(backup.manifestPath).mode & 0o777, 0o600);
    assert.equal(
      backup.directoryPath,
      join(directory, 'backups', '20260714T010203004Z-fixed-id'),
    );
    assert.equal(
      existsSync(
        join(directory, 'backups', '.20260714T010203004Z-fixed-id.reserve'),
      ),
      false,
    );
  } finally {
    source.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('createMigrationBackup rejects a foreign-key-invalid snapshot without publishing it', () => {
  const directory = mkdtempSync(join(tmpdir(), 'migration-backup-invalid-'));
  const sourceDatabasePath = join(directory, 'source.sqlite');
  const source = new Database(sourceDatabasePath, { create: true });

  try {
    source.exec(`
      PRAGMA foreign_keys = OFF;
      CREATE TABLE parents (id INTEGER PRIMARY KEY);
      CREATE TABLE children (
        parent_id INTEGER NOT NULL REFERENCES parents(id)
      );
      INSERT INTO children VALUES (999);
    `);

    assert.throws(
      () =>
        createMigrationBackup({
          database: source,
          sourceDatabasePath,
          sourceSchemaVersion: 1,
          targetSchemaVersion: 2,
          now: () => new Date('2026-07-14T02:00:00.000Z'),
          randomId: () => 'invalid-snapshot',
        }),
      /foreign_key_check/,
    );
    assert.equal(
      existsSync(
        join(directory, 'backups', '20260714T020000000Z-invalid-snapshot'),
      ),
      false,
    );
    assert.equal(
      existsSync(
        join(directory, 'backups', '.20260714T020000000Z-invalid-snapshot.tmp'),
      ),
      false,
    );
  } finally {
    source.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('createMigrationBackup refuses to overwrite a backup with the same generated id', () => {
  const directory = mkdtempSync(join(tmpdir(), 'migration-backup-conflict-'));
  const sourceDatabasePath = join(directory, 'source.sqlite');
  const source = new Database(sourceDatabasePath, { create: true });
  const fixedOptions = {
    database: source,
    sourceDatabasePath,
    sourceSchemaVersion: 7,
    targetSchemaVersion: 8,
    now: () => new Date('2026-07-14T03:00:00.000Z'),
    randomId: () => 'same-id',
  };

  try {
    source.exec('CREATE TABLE retained (value TEXT NOT NULL)');
    source.query('INSERT INTO retained VALUES (?)').run('first backup');
    const first = createMigrationBackup(fixedOptions);
    const originalManifest = readFileSync(first.manifestPath, 'utf8');

    source.query('INSERT INTO retained VALUES (?)').run('second attempt');
    assert.throws(
      () => createMigrationBackup(fixedOptions),
      /Refusing to overwrite backup/,
    );
    assert.equal(readFileSync(first.manifestPath, 'utf8'), originalManifest);
    assert.equal(
      existsSync(
        join(directory, 'backups', '.20260714T030000000Z-same-id.tmp'),
      ),
      false,
    );
  } finally {
    source.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('createMigrationBackup refuses to replace a pre-existing temporary directory', () => {
  const directory = mkdtempSync(
    join(tmpdir(), 'migration-backup-tmp-conflict-'),
  );
  const sourceDatabasePath = join(directory, 'source.sqlite');
  const source = new Database(sourceDatabasePath, { create: true });
  const temporaryDirectoryPath = join(
    directory,
    'backups',
    '.20260714T040000000Z-existing-tmp.tmp',
  );
  const sentinelPath = join(temporaryDirectoryPath, 'owned-by-another-run');

  try {
    mkdirSync(temporaryDirectoryPath, { recursive: true });
    writeFileSync(sentinelPath, 'keep');
    assert.throws(
      () =>
        createMigrationBackup({
          database: source,
          sourceDatabasePath,
          sourceSchemaVersion: 1,
          targetSchemaVersion: 2,
          now: () => new Date('2026-07-14T04:00:00.000Z'),
          randomId: () => 'existing-tmp',
        }),
      /Refusing to overwrite backup/,
    );
    assert.equal(readFileSync(sentinelPath, 'utf8'), 'keep');
  } finally {
    source.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('createMigrationBackup rejects an oversized automatic snapshot before creating artifacts', () => {
  const directory = mkdtempSync(join(tmpdir(), 'migration-backup-cleanup-'));
  const sourceDatabasePath = join(directory, 'source.sqlite');
  const source = new Database(sourceDatabasePath, { create: true });
  const backupId = '20260714T050000000Z-oversized';

  try {
    source.exec('CREATE TABLE values_table (value TEXT)');
    assert.throws(
      () =>
        createMigrationBackup({
          database: source,
          sourceDatabasePath,
          sourceSchemaVersion: 1,
          targetSchemaVersion: 2,
          now: () => new Date('2026-07-14T05:00:00.000Z'),
          randomId: () => 'oversized',
          maxSnapshotBytes: 1,
        }),
      /snapshot limit/,
    );
    assert.equal(
      existsSync(join(directory, 'backups', `.${backupId}.tmp`)),
      false,
    );
    assert.equal(existsSync(join(directory, 'backups', backupId)), false);
    assert.equal(
      existsSync(join(directory, 'backups', `.${backupId}.reserve`)),
      false,
    );
  } finally {
    source.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('createMigrationBackup rejects invalid schema versions before creating backups', () => {
  const directory = mkdtempSync(join(tmpdir(), 'migration-backup-version-'));
  const sourceDatabasePath = join(directory, 'source.sqlite');
  const source = new Database(sourceDatabasePath, { create: true });
  const invalidVersions = [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN];

  try {
    for (const invalidVersion of invalidVersions) {
      for (const versionField of [
        'sourceSchemaVersion',
        'targetSchemaVersion',
      ] as const) {
        assert.throws(
          () =>
            createMigrationBackup({
              database: source,
              sourceDatabasePath,
              sourceSchemaVersion:
                versionField === 'sourceSchemaVersion' ? invalidVersion : 1,
              targetSchemaVersion:
                versionField === 'targetSchemaVersion' ? invalidVersion : 2,
              now: () => new Date('2026-07-14T06:00:00.000Z'),
              randomId: () => `${versionField}-${String(invalidVersion)}`,
            }),
          /non-negative safe integer/,
        );
      }
    }
    assert.equal(existsSync(join(directory, 'backups')), false);
  } finally {
    source.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('createMigrationBackup rejects an invalid date and unsafe random ids', () => {
  const directory = mkdtempSync(join(tmpdir(), 'migration-backup-id-'));
  const sourceDatabasePath = join(directory, 'source.sqlite');
  const source = new Database(sourceDatabasePath, { create: true });
  const validOptions = {
    database: source,
    sourceDatabasePath,
    sourceSchemaVersion: 1,
    targetSchemaVersion: 2,
  };

  try {
    assert.throws(
      () =>
        createMigrationBackup({
          ...validOptions,
          now: () => new Date(Number.NaN),
          randomId: () => 'valid-id',
        }),
      /valid Date/,
    );

    for (const unsafeId of ['', '.', '..', 'nested/id', 'nested\\id']) {
      assert.throws(
        () =>
          createMigrationBackup({
            ...validOptions,
            now: () => new Date('2026-07-14T07:00:00.000Z'),
            randomId: () => unsafeId,
          }),
        /safe single path segment/,
      );
    }
    assert.equal(existsSync(join(directory, 'backups')), false);
  } finally {
    source.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('createMigrationBackup rejects a source path that does not match the connection', () => {
  const directory = mkdtempSync(join(tmpdir(), 'migration-backup-path-'));
  const actualDatabasePath = join(directory, 'actual.sqlite');
  const claimedDatabasePath = join(directory, 'claimed.sqlite');
  const source = new Database(actualDatabasePath, { create: true });

  try {
    assert.throws(
      () =>
        createMigrationBackup({
          database: source,
          sourceDatabasePath: claimedDatabasePath,
          sourceSchemaVersion: 1,
          targetSchemaVersion: 2,
        }),
      /does not match the database connection/,
    );
    assert.equal(existsSync(join(directory, 'backups')), false);
  } finally {
    source.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('createMigrationBackup rejects memory and anonymous connections', () => {
  for (const filename of [':memory:', '']) {
    const source = new Database(filename);
    try {
      assert.throws(
        () =>
          createMigrationBackup({
            database: source,
            sourceDatabasePath: filename,
            sourceSchemaVersion: 0,
            targetSchemaVersion: 1,
          }),
        /named file database/,
      );
    } finally {
      source.close();
    }
  }
});

test('createMigrationBackup respects an exclusive reservation for the generated id', () => {
  const directory = mkdtempSync(join(tmpdir(), 'migration-backup-reserve-'));
  const sourceDatabasePath = join(directory, 'source.sqlite');
  const source = new Database(sourceDatabasePath, { create: true });
  const reservationPath = join(
    directory,
    'backups',
    '.20260714T080000000Z-contended.reserve',
  );

  try {
    mkdirSync(join(directory, 'backups'));
    writeFileSync(reservationPath, 'first participant', { flag: 'wx' });
    assert.throws(
      () =>
        createMigrationBackup({
          database: source,
          sourceDatabasePath,
          sourceSchemaVersion: 1,
          targetSchemaVersion: 2,
          now: () => new Date('2026-07-14T08:00:00.000Z'),
          randomId: () => 'contended',
        }),
      /reservation/,
    );
    assert.equal(readFileSync(reservationPath, 'utf8'), 'first participant');
  } finally {
    source.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('createMigrationBackup supports paths containing single quotes', () => {
  const directory = mkdtempSync(join(tmpdir(), "migration-backup-'quoted-"));
  const sourceDatabasePath = join(directory, 'manifest.json');
  const source = new Database(sourceDatabasePath, { create: true });

  try {
    source.exec(
      "CREATE TABLE quoted_path (value TEXT); INSERT INTO quoted_path VALUES ('ok')",
    );
    const backup = createMigrationBackup({
      database: source,
      sourceDatabasePath,
      sourceSchemaVersion: 1,
      targetSchemaVersion: 2,
      now: () => new Date('2026-07-14T09:00:00.000Z'),
      randomId: () => 'quoted',
    });
    assert.equal(backup.manifest.databaseFile, 'colorful-code.db');
    const snapshot = new Database(backup.databasePath, { readonly: true });
    try {
      assert.equal(
        snapshot
          .query<{ value: string }, []>('SELECT value FROM quoted_path')
          .get()?.value,
        'ok',
      );
    } finally {
      snapshot.close();
    }
  } finally {
    source.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
