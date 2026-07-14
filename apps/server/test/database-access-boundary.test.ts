import { strict as assert } from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';

const sourceRoot = join(import.meta.dir, '../src');
const testSupportRoot = join(import.meta.dir, 'support');

function testSupportFiles(): Array<{ path: string; source: string }> {
  return readdirSync(testSupportRoot, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => {
      const path = join(entry.parentPath, entry.name);
      return {
        path: relative(testSupportRoot, path),
        source: readFileSync(path, 'utf8'),
      };
    });
}

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
    'persistence/legacy-schema-baseline.ts',
    'persistence/migration-backup-recovery.ts',
    'persistence/migration-bootstrap.ts',
    'persistence/migration-framework.ts',
    'persistence/sqlite-checkpoint.ts',
    'persistence/sqlite-configuration.ts',
    'persistence/sqlite-diagnostics.ts',
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
    files
      .filter(({ path, source }) =>
        /(?:database-provider\.testing|TestDatabaseProviderOptions|createInternalTestDatabaseProvider|createTestDatabaseProvider)/.test(
          `${path}\n${source}`,
        ),
      )
      .map(({ path }) => path)
      .sort(),
    [],
  );
  assert.deepEqual(
    violations(
      files,
      /database-provider-internal/,
      new Set([
        'persistence/database-provider-internal.ts',
        'persistence/database-provider.ts',
      ]),
    ),
    [],
  );
  const publicProvider = files.find(
    ({ path }) => path === 'persistence/database-provider.ts',
  );
  assert.ok(publicProvider);
  assert.doesNotMatch(
    publicProvider.source,
    /DatabaseProviderDependencyOverrides|createDatabaseProviderWithDependencies/,
  );
});

test('shared test support cannot bypass the unified Test Database Factory', () => {
  const files = testSupportFiles();
  const factoryOnly = new Set(['test-database-factory.ts']);
  assert.deepEqual(
    violations(
      files,
      /from\s+['"]bun:sqlite['"]|\bmkdtemp\s*\(|\bbootstrapMigrations\s*\(/,
      factoryOnly,
    ),
    [],
  );
  assert.deepEqual(
    violations(
      files,
      /createTestDatabaseProvider\s*\(/,
      new Set(['test-database-factory.ts', 'database-provider-testing.ts']),
    ),
    [],
  );
});

test('daemon startup infrastructure never executes automatic VACUUM', () => {
  assert.deepEqual(
    violations(sourceFiles(), /['"`]\s*VACUUM\b/i, new Set()),
    [],
  );
});

test('business writes use synchronous transaction callbacks and database time', () => {
  const files = sourceFiles();
  assert.deepEqual(
    violations(files, /\.transaction(?:<[^>]+>)?\s*\(\s*async\b/, new Set()),
    [],
  );
  assert.deepEqual(
    violations(
      files,
      /\b(?:database|db)\s*\.\s*(?:insert|update|delete)\s*\(/,
      new Set([
        'persistence/migration-framework.ts',
        'persistence/session-store.ts',
        'plugins/plugin-store.ts',
      ]),
    ),
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

test('business transaction owners cannot acquire external side-effect capabilities', () => {
  const files = sourceFiles();
  const transactionOwners = files.filter(({ source }) =>
    /\bprovider\.transaction(?:<[^>]+>)?\s*\(/.test(source),
  );
  assert.deepEqual(transactionOwners.map(({ path }) => path).sort(), [
    'persistence/session-store.ts',
    'plugins/plugin-store.ts',
  ]);
  for (const { path, source } of transactionOwners) {
    assert.doesNotMatch(
      source,
      /(?:from\s+['"]node:(?:fs|fs\/promises|child_process|http|https|net)['"]|\bfetch\s*\()/,
      `${path} must not acquire filesystem, process, or network capabilities`,
    );
  }
});
