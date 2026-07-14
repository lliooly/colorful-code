import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import {
  LEGACY_1X_SCHEMA_STATEMENTS,
  canonicalSchemaManifest,
  inspectLegacySchema,
} from '../src/persistence/legacy-schema-baseline';

const outputPath = join(
  import.meta.dir,
  '..',
  'test',
  'fixtures',
  'legacy-v1',
  'schema-manifest.json',
);
const database = new Database(':memory:');
try {
  for (const statement of LEGACY_1X_SCHEMA_STATEMENTS) database.exec(statement);
  writeFileSync(
    outputPath,
    canonicalSchemaManifest(inspectLegacySchema(database)),
    'utf8',
  );
} finally {
  database.close(true);
}

if (import.meta.main)
  console.log('Generated deterministic 1.x schema manifest');
