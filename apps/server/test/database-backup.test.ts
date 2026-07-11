import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Database } from 'bun:sqlite';
import { backupDatabase } from '../scripts/backup-database';

test('backupDatabase snapshots WAL data and writes a verified manifest', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'colorful-code-backup-'));
  try {
    const sourcePath = join(directory, 'source.db');
    const outputDirectory = join(directory, 'backups');
    const source = new Database(sourcePath, { create: true });
    source.exec(
      'PRAGMA journal_mode=WAL; CREATE TABLE values_table (value TEXT);',
    );
    source.query('INSERT INTO values_table VALUES (?)').run('latest');
    source.close();

    const result = backupDatabase({
      sourcePath,
      outputDirectory,
      timestamp: '20260711T010203Z',
    });
    const backup = new Database(result.databasePath, { readonly: true });
    assert.equal(
      backup
        .query<{ value: string }, []>('SELECT value FROM values_table')
        .get()?.value,
      'latest',
    );
    assert.equal(result.integrityCheck, 'ok');
    assert.equal(result.foreignKeyViolations, 0);
    const bytes = await readFile(result.databasePath);
    assert.equal(
      createHash('sha256').update(bytes).digest('hex'),
      result.sha256,
    );
    const manifest = JSON.parse(await readFile(result.manifestPath, 'utf8'));
    assert.equal(manifest.sha256, result.sha256);
    backup.close();
    assert.throws(() =>
      backupDatabase({
        sourcePath,
        outputDirectory,
        timestamp: '20260711T010203Z',
      }),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('backupDatabase rejects a corrupt source without publishing a backup', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'colorful-code-backup-'));
  try {
    const sourcePath = join(directory, 'broken.db');
    const outputDirectory = join(directory, 'backups');
    await writeFile(sourcePath, 'not sqlite');
    assert.throws(() => backupDatabase({ sourcePath, outputDirectory }));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
