import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { Database } from 'bun:sqlite';

const fixtureDirectory = join(
  import.meta.dir,
  '..',
  'test',
  'fixtures',
  'legacy-v1',
);

export function createLegacyFixture(outputPath: string): void {
  if (existsSync(outputPath)) {
    throw new Error(`Refusing to overwrite existing fixture: ${outputPath}`);
  }
  mkdirSync(dirname(outputPath), { recursive: true });

  const schema = readFileSync(join(fixtureDirectory, 'schema.sql'), 'utf8');
  const snapshot = readFileSync(
    join(fixtureDirectory, 'session-snapshot.json'),
    'utf8',
  ).trim();
  const raw = new Database(outputPath, { create: true });

  try {
    raw.exec(schema);
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
          `INSERT INTO projects
           (id, name, path, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          'legacy-project-1',
          'Fixture Workspace',
          '/fixture/workspace',
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
    })();
  } catch (error) {
    raw.close();
    throw error;
  }

  raw.close();
}

if (import.meta.main) {
  const outputPath = Bun.argv[2];
  if (!outputPath) {
    throw new Error(
      'Usage: bun apps/server/scripts/create-legacy-fixture.ts <output.db>',
    );
  }
  createLegacyFixture(outputPath);
  console.log(`Created deterministic legacy fixture: ${outputPath}`);
}
