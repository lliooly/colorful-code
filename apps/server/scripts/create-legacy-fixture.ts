import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { Database } from 'bun:sqlite';
import {
  LEGACY_1X_SCHEMA_SOURCE,
  inspectLegacySchema,
  legacySchemaChecksum,
} from '../src/persistence/legacy-schema-baseline';

const fixtureDirectory = join(
  import.meta.dir,
  '..',
  'test',
  'fixtures',
  'legacy-v1',
);

export type LegacyFixtureVariant =
  | 'normal'
  | 'missing-optional'
  | 'orphaned'
  | 'corrupt-record';

export type LegacyFixtureOptions = {
  variant?: LegacyFixtureVariant;
};

const logicalFixtureQueries = [
  `SELECT id, snapshot, updated_at
   FROM sessions
   ORDER BY id`,
  `SELECT id, session_id, parent_checkpoint_id, created_at, run_id,
          label, summary, snapshot, file_changes
   FROM checkpoints
   ORDER BY created_at, id`,
  `SELECT id, session_id, tool_use_id, tool_name, behavior, reason, at
   FROM audit
   ORDER BY at, id`,
  `SELECT id, name, path, created_at, updated_at
   FROM projects
   ORDER BY name, path, id`,
  `SELECT session_id, project_id, pinned, created_at, updated_at
   FROM session_metadata
   ORDER BY session_id`,
  `SELECT id, kind, registry_name, title, description, version, enabled,
          config, installed_at, updated_at
   FROM installed_plugins
   ORDER BY id`,
] as const;

export function legacyFixtureLogicalChecksum(database: Database): string {
  const logicalRows = logicalFixtureQueries.map((query) =>
    database.query(query).all(),
  );
  return createHash('sha256')
    .update(legacySchemaChecksum(inspectLegacySchema(database)), 'utf8')
    .update('\0', 'utf8')
    .update(JSON.stringify(logicalRows), 'utf8')
    .digest('hex');
}

export function createLegacyFixture(
  outputPath: string,
  options: LegacyFixtureOptions = {},
): void {
  if (existsSync(outputPath)) {
    throw new Error(`Refusing to overwrite existing fixture: ${outputPath}`);
  }
  mkdirSync(dirname(outputPath), { recursive: true });

  const snapshot = readFileSync(
    join(fixtureDirectory, 'session-snapshot.json'),
    'utf8',
  ).trim();
  const parsedSnapshot = JSON.parse(snapshot) as Record<string, unknown>;
  const missingOptionalSnapshot = JSON.stringify({
    id: 'legacy-session-missing-optional',
    history: parsedSnapshot.history,
    permissionMode: parsedSnapshot.permissionMode,
    workspaceRoots: [],
    todos: [],
  });
  const variant = options.variant ?? 'normal';

  if (
    !['normal', 'missing-optional', 'orphaned', 'corrupt-record'].includes(
      variant,
    )
  ) {
    throw new TypeError('Unknown legacy fixture variant');
  }
  const raw = new Database(outputPath, { create: true });

  try {
    raw.exec(LEGACY_1X_SCHEMA_SOURCE);
    raw.transaction(() => {
      raw
        .query(
          'INSERT INTO sessions (id, snapshot, updated_at) VALUES (?, ?, ?)',
        )
        .run('legacy-session-1', snapshot, 1_700_000_000_000);
      raw
        .query(
          `INSERT INTO checkpoints
           (id, session_id, parent_checkpoint_id, created_at, run_id, label, summary, snapshot, file_changes)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          'legacy-checkpoint-1',
          'legacy-session-1',
          null,
          1_700_000_000_100,
          'legacy-run-1',
          'Baseline',
          'Deterministic legacy fixture',
          snapshot,
          JSON.stringify([]),
        );
      raw
        .query(
          `INSERT INTO checkpoints
           (id, session_id, parent_checkpoint_id, created_at, run_id, label, summary, snapshot, file_changes)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          'legacy-checkpoint-2',
          'legacy-session-1',
          'legacy-checkpoint-1',
          1_700_000_000_150,
          'legacy-run-2',
          'Follow-up',
          'Deterministic child checkpoint',
          snapshot,
          JSON.stringify([
            {
              path: 'fixture-workspace/README.md',
              status: 'modified',
              additions: 1,
              deletions: 0,
            },
          ]),
        );
      raw
        .query(
          `INSERT INTO audit
           (session_id, tool_use_id, tool_name, behavior, reason, at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          'legacy-session-1',
          'legacy-tool-use-1',
          'Read',
          'allow',
          JSON.stringify({ type: 'toolDefault' }),
          1_700_000_000_200,
        );
      raw
        .query(
          `INSERT INTO audit
           (session_id, tool_use_id, tool_name, behavior, reason, at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          'legacy-session-1',
          'legacy-tool-use-2',
          'Write',
          'ask',
          JSON.stringify({
            type: 'rule',
            rule: {
              source: 'session',
              behavior: 'ask',
              toolName: 'Write',
            },
          }),
          1_700_000_000_250,
        );
      raw
        .query(
          `INSERT INTO projects
           (id, name, path, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          'legacy-project-1',
          'Fixture Workspace',
          'fixture-workspace',
          1_700_000_000_000,
          1_700_000_000_200,
        );
      raw
        .query(
          `INSERT INTO session_metadata
           (session_id, project_id, pinned, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          'legacy-session-1',
          'legacy-project-1',
          1,
          1_700_000_000_000,
          1_700_000_000_200,
        );
      raw
        .query(
          `INSERT INTO installed_plugins
           (id, kind, registry_name, title, description, version, enabled, config, installed_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          'legacy-plugin-1',
          'mcp',
          'fixture/readonly',
          'Fixture Read-only MCP',
          'Deterministic plugin metadata',
          '1.0.0',
          1,
          JSON.stringify({ transport: 'stdio', command: 'fixture-mcp' }),
          1_700_000_000_000,
          1_700_000_000_200,
        );

      if (variant === 'missing-optional') {
        raw
          .query(
            'INSERT INTO sessions (id, snapshot, updated_at) VALUES (?, ?, ?)',
          )
          .run(
            'legacy-session-missing-optional',
            missingOptionalSnapshot,
            1_700_000_000_300,
          );
        raw
          .query(
            `INSERT INTO checkpoints
             (id, session_id, parent_checkpoint_id, created_at, run_id, label, summary, snapshot, file_changes)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            'legacy-checkpoint-missing-optional',
            'legacy-session-missing-optional',
            null,
            1_700_000_000_300,
            null,
            null,
            null,
            snapshot,
            null,
          );
        raw
          .query(
            `INSERT INTO audit
             (session_id, tool_use_id, tool_name, behavior, reason, at)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(
            'legacy-session-1',
            'legacy-tool-use-missing-reason',
            'Read',
            'allow',
            null,
            1_700_000_000_350,
          );
        raw
          .query(
            `INSERT INTO session_metadata
             (session_id, project_id, pinned, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .run(
            'legacy-session-missing-optional',
            null,
            0,
            1_700_000_000_300,
            1_700_000_000_350,
          );
      }

      if (variant === 'orphaned') {
        raw
          .query(
            `INSERT INTO checkpoints
             (id, session_id, parent_checkpoint_id, created_at, run_id, label, summary, snapshot, file_changes)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            'legacy-orphan-checkpoint',
            'missing-session',
            'missing-checkpoint',
            1_700_000_000_300,
            null,
            'Historical orphan',
            null,
            snapshot,
            null,
          );
        raw
          .query(
            `INSERT INTO audit
             (session_id, tool_use_id, tool_name, behavior, reason, at)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(
            'missing-session',
            'legacy-orphan-tool-use',
            'Read',
            'allow',
            null,
            1_700_000_000_350,
          );
        raw
          .query(
            `INSERT INTO session_metadata
             (session_id, project_id, pinned, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .run(
            'missing-session',
            'missing-project',
            0,
            1_700_000_000_300,
            1_700_000_000_350,
          );
      }

      if (variant === 'corrupt-record') {
        raw
          .query(
            'INSERT INTO sessions (id, snapshot, updated_at) VALUES (?, ?, ?)',
          )
          .run(
            'legacy-session-corrupt-record',
            '{"history": [invalid historical json',
            1_700_000_000_400,
          );
        raw
          .query(
            `INSERT INTO checkpoints
             (id, session_id, parent_checkpoint_id, created_at, run_id, label, summary, snapshot, file_changes)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            'legacy-checkpoint-corrupt-record',
            'legacy-session-corrupt-record',
            null,
            1_700_000_000_400,
            null,
            'Historical malformed payload',
            null,
            '{not-json',
            '[unterminated',
          );
      }
    })();
  } catch (error) {
    raw.close();
    throw error;
  }

  raw.close();
}

if (import.meta.main) {
  const outputPath = Bun.argv[2];
  const variant = Bun.argv[3] as LegacyFixtureVariant | undefined;
  if (!outputPath) {
    throw new Error(
      'Usage: bun apps/server/scripts/create-legacy-fixture.ts <output.db> [normal|missing-optional|orphaned|corrupt-record]',
    );
  }
  if (
    variant !== undefined &&
    !['normal', 'missing-optional', 'orphaned', 'corrupt-record'].includes(
      variant,
    )
  ) {
    throw new Error(`Unknown legacy fixture variant: ${variant}`);
  }
  createLegacyFixture(outputPath, { variant });
  console.log(
    `Created deterministic ${variant ?? 'normal'} legacy fixture: ${outputPath}`,
  );
}
