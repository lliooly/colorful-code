import { strict as assert } from 'node:assert';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Database } from 'bun:sqlite';
import { openDatabase } from '../src/persistence/database';
import { createLegacyFixture } from '../scripts/create-legacy-fixture';

const fixtureDirectory = join(
  import.meta.dir,
  'fixtures',
  'legacy-v1',
);

type SchemaObject = { type: string; name: string; sql: string | null };

function schemaObjects(raw: Database): SchemaObject[] {
  return raw
    .query<SchemaObject, []>(
      `SELECT type, name, sql
       FROM sqlite_schema
       WHERE name NOT LIKE 'sqlite_%'
       ORDER BY type, name`,
    )
    .all()
    .map((entry) => ({
      ...entry,
      sql: entry.sql?.replace(/\s+/g, ' ').trim() ?? null,
    }));
}

function assertNoSecretFields(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(assertNoSecretFields);
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  for (const [key, entry] of Object.entries(value)) {
    assert.doesNotMatch(key, /^(apiKey|token|secret)$/i);
    assertNoSecretFields(entry);
  }
}

async function withTempDirectory(
  run: (directory: string) => Promise<void> | void,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'colorful-code-baseline-'));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('legacy schema manifest matches the production 1.x schema', async () => {
  await withTempDirectory(async (directory) => {
    const manifestPath = join(directory, 'manifest.db');
    const productionPath = join(directory, 'production.db');
    const manifest = new Database(manifestPath, { create: true });
    manifest.exec(await readFile(join(fixtureDirectory, 'schema.sql'), 'utf8'));
    const production = openDatabase(productionPath);

    try {
      assert.deepEqual(schemaObjects(manifest), schemaObjects(production.raw));
    } finally {
      manifest.close();
      production.raw.close();
    }
  });
});

test('legacy fixture generation is deterministic and secret-free', async () => {
  await withTempDirectory(async (directory) => {
    const firstPath = join(directory, 'first.db');
    const secondPath = join(directory, 'second.db');
    createLegacyFixture(firstPath);
    createLegacyFixture(secondPath);

    const first = new Database(firstPath, { readonly: true });
    const second = new Database(secondPath, { readonly: true });
    try {
      for (const table of [
        'sessions',
        'checkpoints',
        'audit',
        'projects',
        'session_metadata',
        'installed_plugins',
      ]) {
        const query = `SELECT * FROM ${table} ORDER BY rowid`;
        assert.deepEqual(first.query(query).all(), second.query(query).all());
      }
      assert.equal(
        first.query<{ integrity_check: string }, []>('PRAGMA integrity_check').get()
          ?.integrity_check,
        'ok',
      );
      assert.deepEqual(first.query('PRAGMA foreign_key_check').all(), []);
      const stored = first.query<{ snapshot: string }, []>(
        'SELECT snapshot FROM sessions',
      ).get();
      assertNoSecretFields(JSON.parse(stored?.snapshot ?? '{}'));
    } finally {
      first.close();
      second.close();
    }
  });
});

test('snapshot and API golden fixtures describe the current restore contract', async () => {
  const snapshot = JSON.parse(
    await readFile(join(fixtureDirectory, 'session-snapshot.json'), 'utf8'),
  ) as Record<string, unknown>;
  const api = JSON.parse(
    await readFile(join(fixtureDirectory, 'api-responses.json'), 'utf8'),
  ) as { restore: Record<string, unknown> };

  assert.equal(snapshot.id, 'legacy-session-1');
  assert.equal(snapshot.permissionMode, 'default');
  assert.deepEqual(api.restore.history, snapshot.history);
  assert.equal(api.restore.permissionMode, snapshot.permissionMode);
  assertNoSecretFields({ snapshot, api });
});
