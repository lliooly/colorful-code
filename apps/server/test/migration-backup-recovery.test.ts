import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { Database } from 'bun:sqlite';
import { createMigrationBackup } from '../src/persistence/migration-backup-recovery';

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
      sourceDatabasePath: resolve(sourceDatabasePath),
      sourceSchemaVersion: 3,
      targetSchemaVersion: 4,
      createdAt: '2026-07-14T01:02:03.004Z',
      databaseFile: 'colorful-code.db',
      sizeBytes: databaseBytes.byteLength,
      sha256: createHash('sha256').update(databaseBytes).digest('hex'),
      integrityCheck: 'ok',
      foreignKeyViolations: 0,
    });
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

test('createMigrationBackup removes its temporary directory when snapshot creation fails', () => {
  const directory = mkdtempSync(join(tmpdir(), 'migration-backup-cleanup-'));
  const sourceDatabasePath = join(directory, 'source.sqlite');
  const source = new Database(sourceDatabasePath, { create: true });
  const backupId = '20260714T050000000Z-vacuum-failure';

  try {
    source.exec('CREATE TABLE values_table (value TEXT); BEGIN');
    assert.throws(() =>
      createMigrationBackup({
        database: source,
        sourceDatabasePath,
        sourceSchemaVersion: 1,
        targetSchemaVersion: 2,
        now: () => new Date('2026-07-14T05:00:00.000Z'),
        randomId: () => 'vacuum-failure',
      }),
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
    source.exec('ROLLBACK');
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

test('createMigrationBackup quotes single quotes in VACUUM INTO paths', () => {
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
