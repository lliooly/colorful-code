import { strict as assert } from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';

const sourceRoot = join(import.meta.dir, '../src');

function sourceFiles(): Array<{ path: string; source: string }> {
  return readdirSync(sourceRoot, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => {
      const path = join(entry.parentPath, entry.name);
      return {
        path: relative(sourceRoot, path),
        source: readFileSync(path, 'utf8'),
      };
    });
}

function violations(
  files: ReturnType<typeof sourceFiles>,
  pattern: RegExp,
  allowed: ReadonlySet<string>,
): string[] {
  return files
    .filter(({ path, source }) => pattern.test(source) && !allowed.has(path))
    .map(({ path }) => path)
    .sort();
}

test('production SQLite ownership and transaction control stay inside infrastructure', () => {
  const files = sourceFiles();
  const sqliteInfrastructure = new Set([
    'persistence/database.ts',
    'persistence/database-clock.ts',
    'persistence/database-provider-internal.ts',
    'persistence/migration-backup-recovery.ts',
    'persistence/migration-bootstrap.ts',
    'persistence/migration-framework.ts',
    'runtime/data-directory-instance-lock.ts',
  ]);
  assert.deepEqual(
    violations(files, /from\s+['"]bun:sqlite['"]/, sqliteInfrastructure),
    [],
  );
  assert.deepEqual(
    violations(
      files,
      /\bopenDatabase\s*\(/,
      new Set([
        'persistence/database.ts',
        'persistence/migration-bootstrap.ts',
      ]),
    ),
    [],
  );
  assert.deepEqual(
    violations(
      files,
      /['"`]\s*(?:BEGIN(?:\s+IMMEDIATE|\s+EXCLUSIVE)?|COMMIT|ROLLBACK)\b/i,
      new Set([
        'persistence/database-provider-internal.ts',
        'persistence/migration-framework.ts',
        'runtime/data-directory-instance-lock.ts',
      ]),
    ),
    [],
  );
});

test('Provider internals and test hooks cannot leak into production business code', () => {
  const files = sourceFiles();
  assert.deepEqual(
    violations(
      files,
      /database-provider\.testing/,
      new Set(['persistence/database-provider.testing.ts']),
    ),
    [],
  );
  assert.deepEqual(
    violations(
      files,
      /database-provider-internal/,
      new Set([
        'persistence/database-provider-internal.ts',
        'persistence/database-provider.testing.ts',
        'persistence/database-provider.ts',
      ]),
    ),
    [],
  );
});

test('business writes use synchronous transaction callbacks and database time', () => {
  const files = sourceFiles();
  assert.deepEqual(
    violations(files, /\.transaction\s*\(\s*async\b/, new Set()),
    [],
  );
  assert.deepEqual(
    violations(
      files,
      /(?:createdAt|updatedAt|installedAt)\s*:\s*Date\.now\s*\(/,
      new Set(),
    ),
    [],
  );
  for (const path of [
    'persistence/session-store.ts',
    'plugins/plugin-store.ts',
  ]) {
    const file = files.find((candidate) => candidate.path === path);
    assert.ok(file);
    assert.doesNotMatch(file.source, /Date\.now\s*\(/);
  }
});
