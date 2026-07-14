import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const FORBIDDEN_PATH =
  /(?:^|[/\\])(?:test|tests|__tests__)(?:[/\\]|$)|(?:^|[/\\])[^/\\]+\.(?:test|spec)\.[^/\\]+$|\.testing\./i;
const FORBIDDEN_TEST_TOKEN =
  /database-provider\.testing|TestDatabaseProviderOptions|createInternalTestDatabaseProvider|(?:create|with)[A-Za-z0-9_$]*Test[A-Za-z0-9_$]*|createLegacyFixture|fixtures[/\\]legacy-v1|__migrationBackupRecoveryTesting/;
const FORBIDDEN_PUBLIC_PROVIDER_TOKEN =
  /createDatabaseProviderWithDependencies|DatabaseProviderDependencyOverrides/;

function listFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? listFiles(path) : [path];
  });
}

export function verifyProductionBuild(directory: string): void {
  const root = resolve(directory);
  if (!statSync(root).isDirectory()) {
    throw new Error('Production build output is not a directory');
  }

  const violations = listFiles(root)
    .flatMap((path) => {
      const outputPath = relative(root, path);
      if (FORBIDDEN_PATH.test(outputPath)) return [outputPath];
      if (!/\.(?:c?js|mjs|json|map|d\.ts)$/.test(path)) return [];
      const source = readFileSync(path, 'utf8');
      if (FORBIDDEN_TEST_TOKEN.test(source)) return [outputPath];
      if (
        /(?:^|[/\\])persistence[/\\](?:database-provider|index)\.(?:c?js|mjs|d\.ts)$/.test(
          outputPath,
        ) &&
        FORBIDDEN_PUBLIC_PROVIDER_TOKEN.test(source)
      ) {
        return [outputPath];
      }
      return [];
    })
    .sort();

  if (violations.length > 0) {
    throw new Error(
      `Production build contains test-only database artifacts: ${violations.join(', ')}`,
    );
  }
}

if (import.meta.main) {
  verifyProductionBuild(join(import.meta.dir, '../dist'));
}
