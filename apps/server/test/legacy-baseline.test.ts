import { strict as assert } from 'node:assert';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Database } from 'bun:sqlite';
import {
  LEGACY_1X_BASELINE_MIGRATION,
  LEGACY_1X_BASELINE_MIGRATION_CHECKSUM,
  bootstrapMigrations,
} from '../src/persistence/migration-bootstrap';
import { createMigrationBackup } from '../src/persistence/migration-backup-recovery';
import {
  MigrationError,
  migrationChecksum,
  runMigrations,
} from '../src/persistence/migration-framework';
import {
  LEGACY_1X_SCHEMA_CHECKSUM,
  LEGACY_1X_SCHEMA_SOURCE,
  LEGACY_1X_SCHEMA_STATEMENTS,
  canonicalSchemaManifest,
  inspectLegacySchema,
  legacySchemaChecksum,
} from '../src/persistence/legacy-schema-baseline';
import {
  createLegacyFixture,
  legacyFixtureLogicalChecksum,
} from '../scripts/create-legacy-fixture';

const fixtureDirectory = join(import.meta.dir, 'fixtures', 'legacy-v1');

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
    assert.doesNotMatch(
      key,
      /^(apiKey|accessToken|refreshToken|token|secret|password|authorization|credential)$/i,
    );
    assertNoSecretFields(entry);
  }
}

function assertFixtureValuesAreSafe(database: Database): void {
  for (const table of [
    'sessions',
    'checkpoints',
    'audit',
    'projects',
    'session_metadata',
    'installed_plugins',
  ]) {
    const rows = database
      .query<Record<string, unknown>, []>(`SELECT * FROM ${table}`)
      .all();
    for (const value of Object.values(rows).flatMap((row) =>
      Object.values(row),
    )) {
      if (typeof value !== 'string') continue;
      assert.doesNotMatch(value, /\/(?:Users|home|root)\//i);
      assert.doesNotMatch(value, /[A-Z]:\\Users\\/i);
      assert.doesNotMatch(
        value,
        /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
      );
      assert.doesNotMatch(value, /[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@/i);
      assert.doesNotMatch(
        value,
        /"(?:apiKey|accessToken|refreshToken|token|secret|password|authorization|credential)"\s*:\s*"[^"]+"/i,
      );
    }
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

test('legacy schema source is frozen from the published 1.x fixture', async () => {
  assert.equal(
    await readFile(join(fixtureDirectory, 'schema.sql'), 'utf8'),
    LEGACY_1X_SCHEMA_SOURCE,
  );
});

test('published 1.x schema and baseline migration checksums match the immutable version map', async () => {
  const versionMap = JSON.parse(
    await readFile(join(fixtureDirectory, 'version-map.json'), 'utf8'),
  ) as {
    legacySchemaChecksum: string;
    migrationBaselineChecksum: string;
    knownApplicationSchemaMappings: unknown[];
  };
  assert.equal(versionMap.legacySchemaChecksum, LEGACY_1X_SCHEMA_CHECKSUM);
  assert.equal(
    versionMap.migrationBaselineChecksum,
    LEGACY_1X_BASELINE_MIGRATION_CHECKSUM,
  );
  assert.equal(
    migrationChecksum(LEGACY_1X_BASELINE_MIGRATION),
    LEGACY_1X_BASELINE_MIGRATION_CHECKSUM,
  );
  assert.ok(versionMap.knownApplicationSchemaMappings.length > 0);
});

test('1.x manifest records columns, indexes, autoindexes, internals, and version deterministically', async () => {
  await withTempDirectory(async (directory) => {
    const first = new Database(join(directory, 'first-schema.db'), {
      create: true,
    });
    const second = new Database(join(directory, 'second-schema.db'), {
      create: true,
    });
    try {
      for (const statement of LEGACY_1X_SCHEMA_STATEMENTS) {
        first.exec(statement);
      }
      const reorderedStatements = [
        ...LEGACY_1X_SCHEMA_STATEMENTS.filter((statement) =>
          statement.startsWith('CREATE TABLE'),
        ).reverse(),
        ...LEGACY_1X_SCHEMA_STATEMENTS.filter((statement) =>
          statement.startsWith('CREATE INDEX'),
        ).reverse(),
        ...LEGACY_1X_SCHEMA_STATEMENTS.filter((statement) =>
          statement.startsWith('CREATE UNIQUE INDEX'),
        ).reverse(),
      ];
      for (const statement of reorderedStatements) {
        second.exec(statement);
      }

      const firstManifest = inspectLegacySchema(first);
      const secondManifest = inspectLegacySchema(second);
      assert.equal(firstManifest.userVersion, 0);
      assert.equal(firstManifest.sqliteInternals.sequenceTable, true);
      assert.deepEqual(
        firstManifest.tables.map(({ name }) => name),
        [
          'audit',
          'checkpoints',
          'installed_plugins',
          'projects',
          'session_metadata',
          'sessions',
        ],
      );
      assert.equal(
        firstManifest.tables
          .flatMap(({ indexes }) => indexes)
          .filter(({ origin }) => origin === 'pk').length,
        5,
      );
      assert.deepEqual(
        firstManifest.tables.flatMap(({ foreignKeys }) => foreignKeys),
        [],
      );
      assert.deepEqual(firstManifest.triggers, []);
      assert.deepEqual(firstManifest.views, []);
      assert.deepEqual(secondManifest, firstManifest);
      assert.equal(
        legacySchemaChecksum(firstManifest),
        LEGACY_1X_SCHEMA_CHECKSUM,
      );
      assert.equal(
        await readFile(join(fixtureDirectory, 'schema-manifest.json'), 'utf8'),
        canonicalSchemaManifest(firstManifest),
      );
      assert.match(LEGACY_1X_SCHEMA_CHECKSUM, /^[0-9a-f]{64}$/);
    } finally {
      first.close();
      second.close();
    }
  });
});

test('legacy checksum detects SQL constraints that PRAGMA columns do not expose', async () => {
  await withTempDirectory(async (directory) => {
    const database = new Database(join(directory, 'constraint.db'), {
      create: true,
    });
    try {
      for (const statement of LEGACY_1X_SCHEMA_STATEMENTS) {
        database.exec(
          statement.startsWith('CREATE TABLE sessions')
            ? statement.replace(
                'snapshot TEXT NOT NULL,',
                'snapshot TEXT NOT NULL CHECK(length(snapshot) > 0),',
              )
            : statement,
        );
      }
      assert.notEqual(
        legacySchemaChecksum(inspectLegacySchema(database)),
        LEGACY_1X_SCHEMA_CHECKSUM,
      );
    } finally {
      database.close(true);
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
      const versionMap = JSON.parse(
        await readFile(join(fixtureDirectory, 'version-map.json'), 'utf8'),
      ) as { fixtureLogicalChecksums: Record<string, string> };
      assert.equal(
        legacyFixtureLogicalChecksum(first),
        versionMap.fixtureLogicalChecksums.normal,
      );
      assert.equal(
        legacyFixtureLogicalChecksum(second),
        versionMap.fixtureLogicalChecksums.normal,
      );
      assert.equal(
        first
          .query<{ integrity_check: string }, []>('PRAGMA integrity_check')
          .get()?.integrity_check,
        'ok',
      );
      assert.deepEqual(first.query('PRAGMA foreign_key_check').all(), []);
      const stored = first
        .query<{ snapshot: string }, []>('SELECT snapshot FROM sessions')
        .get();
      const snapshot = JSON.parse(stored?.snapshot ?? '{}') as Record<
        string,
        unknown
      >;
      assertNoSecretFields(snapshot);
      assert.deepEqual(snapshot.history, []);
      assert.deepEqual(snapshot.modelConfig, {
        presetId: 'fixture-openai-compatible',
        protocol: 'openai',
        model: 'fixture-model',
      });
      assert.doesNotMatch(JSON.stringify(snapshot), /\/Users\/|\/home\//i);
      assertFixtureValuesAreSafe(first);
      assert.ok(
        typeof snapshot.cwd === 'string' && !snapshot.cwd.startsWith('/'),
      );

      assert.deepEqual(
        first
          .query<{ id: string; parent_checkpoint_id: string | null }, []>(
            `SELECT id, parent_checkpoint_id
             FROM checkpoints
             ORDER BY created_at, id`,
          )
          .all(),
        [
          { id: 'legacy-checkpoint-1', parent_checkpoint_id: null },
          {
            id: 'legacy-checkpoint-2',
            parent_checkpoint_id: 'legacy-checkpoint-1',
          },
        ],
      );
      assert.equal(
        first.query('SELECT * FROM audit ORDER BY at, id').all().length,
        2,
      );
      assert.equal(
        first.query('SELECT * FROM projects ORDER BY name, path').all().length,
        1,
      );
      assert.equal(
        first.query('SELECT * FROM session_metadata ORDER BY session_id').all()
          .length,
        1,
      );
    } finally {
      first.close();
      second.close();
    }
  });
});

test('legacy fixture historical variants are deterministic and preserve known anomalies', async () => {
  await withTempDirectory(async (directory) => {
    const versionMap = JSON.parse(
      await readFile(join(fixtureDirectory, 'version-map.json'), 'utf8'),
    ) as { fixtureLogicalChecksums: Record<string, string> };
    const variants = [
      'missing-optional',
      'orphaned',
      'corrupt-record',
    ] as const;

    for (const variant of variants) {
      const firstPath = join(directory, `${variant}-first.db`);
      const secondPath = join(directory, `${variant}-second.db`);
      createLegacyFixture(firstPath, { variant });
      createLegacyFixture(secondPath, { variant });
      const first = new Database(firstPath, { readonly: true });
      const second = new Database(secondPath, { readonly: true });
      try {
        assert.equal(
          legacyFixtureLogicalChecksum(first),
          versionMap.fixtureLogicalChecksums[variant],
        );
        assert.equal(
          legacyFixtureLogicalChecksum(second),
          versionMap.fixtureLogicalChecksums[variant],
        );
        assert.equal(
          legacyFixtureLogicalChecksum(first),
          legacyFixtureLogicalChecksum(second),
        );
        assertFixtureValuesAreSafe(first);
        if (variant !== 'corrupt-record') {
          assertNoSecretFields(
            first
              .query<{ snapshot: string }, []>(
                'SELECT snapshot FROM sessions ORDER BY id',
              )
              .all()
              .map(({ snapshot }) => JSON.parse(snapshot)),
          );
        }
      } finally {
        first.close(true);
        second.close(true);
      }

      await bootstrapMigrations(firstPath);
      const migrated = new Database(firstPath, { readonly: true });
      try {
        assert.deepEqual(
          migrated
            .query<
              { version: number },
              []
            >('SELECT version FROM schema_migrations')
            .all(),
          [{ version: 1 }],
        );
        if (variant === 'missing-optional') {
          assert.deepEqual(
            migrated
              .query<
                {
                  parent_checkpoint_id: null;
                  run_id: null;
                  label: null;
                  summary: null;
                  file_changes: null;
                },
                []
              >(
                `SELECT parent_checkpoint_id, run_id, label, summary, file_changes
                 FROM checkpoints
                 WHERE id = 'legacy-checkpoint-missing-optional'`,
              )
              .get(),
            {
              parent_checkpoint_id: null,
              run_id: null,
              label: null,
              summary: null,
              file_changes: null,
            },
          );
          const historicalSnapshot = JSON.parse(
            migrated
              .query<{ snapshot: string }, []>(
                `SELECT snapshot
                 FROM sessions
                 WHERE id = 'legacy-session-missing-optional'`,
              )
              .get()?.snapshot ?? '{}',
          ) as Record<string, unknown>;
          assert.equal(historicalSnapshot.cwd, undefined);
          assert.equal(historicalSnapshot.lastInputTokens, undefined);
          assert.equal(historicalSnapshot.modelConfig, undefined);
          assert.equal(
            migrated
              .query<{ project_id: string | null }, []>(
                `SELECT project_id
                 FROM session_metadata
                 WHERE session_id = 'legacy-session-missing-optional'`,
              )
              .get()?.project_id,
            null,
          );
        } else if (variant === 'orphaned') {
          assert.equal(
            migrated
              .query<{ count: number }, []>(
                `SELECT count(*) AS count
                 FROM checkpoints
                 WHERE session_id = 'missing-session'
                    OR parent_checkpoint_id = 'missing-checkpoint'`,
              )
              .get()?.count,
            1,
          );
          assert.equal(
            migrated
              .query<{ count: number }, []>(
                `SELECT count(*) AS count
                 FROM session_metadata
                 WHERE project_id = 'missing-project'`,
              )
              .get()?.count,
            1,
          );
        } else {
          assert.equal(
            migrated
              .query<{ snapshot: string }, []>(
                `SELECT snapshot FROM sessions
                  WHERE id = 'legacy-session-corrupt-record'`,
              )
              .get()?.snapshot,
            '{"history": [invalid historical json',
          );
          assert.equal(
            migrated
              .query<{ file_changes: string }, []>(
                `SELECT file_changes FROM checkpoints
                  WHERE id = 'legacy-checkpoint-corrupt-record'`,
              )
              .get()?.file_changes,
            '[unterminated',
          );
        }
      } finally {
        migrated.close(true);
      }
    }
  });
});

test('migration bootstrap adopts an exact 1.x fixture without replaying baseline DDL', async () => {
  await withTempDirectory(async (directory) => {
    const databasePath = join(directory, 'legacy.db');
    createLegacyFixture(databasePath);
    const before = new Database(databasePath, { readonly: true });
    let beforeSchema: SchemaObject[];
    let beforeRows: unknown[];
    try {
      beforeSchema = schemaObjects(before);
      beforeRows = before.query('SELECT * FROM sessions ORDER BY id').all();
    } finally {
      before.close();
    }

    await bootstrapMigrations(databasePath);

    const migrated = new Database(databasePath, { readonly: true });
    try {
      assert.deepEqual(
        schemaObjects(migrated).filter(
          ({ name }) => name !== 'schema_migrations',
        ),
        beforeSchema,
      );
      assert.deepEqual(
        migrated.query('SELECT * FROM sessions ORDER BY id').all(),
        beforeRows,
      );
      assert.deepEqual(
        migrated
          .query<
            { version: number; name: string },
            []
          >('SELECT version, name FROM schema_migrations')
          .all(),
        [{ version: 1, name: 'legacy_1x_baseline' }],
      );
      assert.equal(
        legacySchemaChecksum(inspectLegacySchema(migrated)),
        LEGACY_1X_SCHEMA_CHECKSUM,
      );
    } finally {
      migrated.close();
    }
  });
});

test('migration bootstrap repairs an exact 1.x fixture with valid empty metadata', async () => {
  await withTempDirectory(async (directory) => {
    const databasePath = join(directory, 'legacy-empty-metadata.db');
    createLegacyFixture(databasePath);
    const interrupted = new Database(databasePath, { readwrite: true });
    try {
      runMigrations(interrupted, []);
      assert.equal(
        interrupted
          .query<
            { count: number },
            []
          >('SELECT count(*) AS count FROM schema_migrations')
          .get()?.count,
        0,
      );
    } finally {
      interrupted.close(true);
    }

    await bootstrapMigrations(databasePath);

    const reopened = new Database(databasePath, { readonly: true });
    try {
      assert.deepEqual(
        reopened
          .query<
            { version: number; name: string },
            []
          >('SELECT version, name FROM schema_migrations')
          .all(),
        [{ version: 1, name: 'legacy_1x_baseline' }],
      );
      assert.equal(
        reopened
          .query<
            { count: number },
            []
          >('SELECT count(*) AS count FROM sessions')
          .get()?.count,
        1,
      );
    } finally {
      reopened.close(true);
    }
  });
});

test('migration bootstrap rejects an unknown unmanaged schema before mutation', async () => {
  await withTempDirectory(async (directory) => {
    const databasePath = join(directory, 'unknown.db');
    const unknown = new Database(databasePath, { create: true });
    unknown.exec('CREATE TABLE third_party(value TEXT);');
    unknown.close();

    await assert.rejects(
      bootstrapMigrations(databasePath),
      (error: unknown) =>
        error instanceof MigrationError &&
        error.code === 'unsupported_unmanaged_schema',
    );

    const reopened = new Database(databasePath, { readonly: true });
    try {
      assert.equal(
        reopened
          .query<
            { count: number },
            []
          >("SELECT count(*) AS count FROM sqlite_schema WHERE name = 'schema_migrations'")
          .get()?.count,
        0,
      );
      assert.equal(
        reopened
          .query<
            { count: number },
            []
          >("SELECT count(*) AS count FROM sqlite_schema WHERE name = 'third_party'")
          .get()?.count,
        1,
      );
    } finally {
      reopened.close();
    }
  });
});

test('baseline adoption rejects post-backup row drift without restoring over it', async () => {
  await withTempDirectory(async (directory) => {
    const databasePath = join(directory, 'concurrent.db');
    createLegacyFixture(databasePath);

    await assert.rejects(
      bootstrapMigrations(databasePath, {
        createBackup(options) {
          const backup = createMigrationBackup({
            ...options,
            database: options.database as Database,
          });
          const concurrent = new Database(databasePath, { readwrite: true });
          try {
            concurrent
              .query(
                `INSERT INTO audit
                   (session_id, tool_use_id, tool_name, behavior, reason, at)
                 VALUES (?, ?, ?, ?, ?, ?)`,
              )
              .run(
                'concurrent-session',
                'concurrent-use',
                'Concurrent',
                'allow',
                null,
                1_700_000_000_999,
              );
          } finally {
            concurrent.close(true);
          }
          return backup;
        },
      }),
      (error: unknown) =>
        error instanceof MigrationError &&
        error.code === 'database_changed_during_backup',
    );

    const reopened = new Database(databasePath, { readonly: true });
    try {
      assert.equal(
        reopened
          .query<
            { count: number },
            []
          >("SELECT count(*) AS count FROM audit WHERE tool_use_id = 'concurrent-use'")
          .get()?.count,
        1,
      );
      assert.equal(
        reopened
          .query<
            { count: number },
            []
          >("SELECT count(*) AS count FROM sqlite_schema WHERE name = 'schema_migrations'")
          .get()?.count,
        0,
      );
    } finally {
      reopened.close(true);
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
  assert.deepEqual(snapshot.history, []);
  assert.doesNotMatch(
    JSON.stringify({ snapshot, api }),
    /"(?:api[_-]?key|token|secret)"\s*:/i,
  );
  assert.doesNotMatch(JSON.stringify({ snapshot, api }), /\/Users\/|\/home\//i);
  assertNoSecretFields({ snapshot, api });
});
