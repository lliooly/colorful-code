import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { verifyProductionBuild } from '../scripts/verify-production-build';

test('production build verifier rejects test-only Provider artifacts', () => {
  const directory = mkdtempSync(join(tmpdir(), 'colorful-code-dist-check-'));
  try {
    mkdirSync(join(directory, 'persistence'));
    writeFileSync(
      join(directory, 'persistence/database-provider.testing.js'),
      'export function createTestDatabaseProvider() {}',
    );

    assert.throws(
      () => verifyProductionBuild(directory),
      /test-only database artifacts/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('production build verifier accepts production-only Provider artifacts', () => {
  const directory = mkdtempSync(join(tmpdir(), 'colorful-code-dist-check-'));
  try {
    mkdirSync(join(directory, 'persistence'));
    writeFileSync(
      join(directory, 'persistence/database-provider.js'),
      'export function createDatabaseProvider() {}',
    );

    assert.doesNotThrow(() => verifyProductionBuild(directory));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('production build verifier rejects generic test names and public dependency override seams', () => {
  const directory = mkdtempSync(join(tmpdir(), 'colorful-code-dist-check-'));
  try {
    mkdirSync(join(directory, 'persistence'));
    writeFileSync(
      join(directory, 'persistence/database-provider.js'),
      'export function createDatabaseProviderWithDependencies() {}',
    );
    assert.throws(
      () => verifyProductionBuild(directory),
      /test-only database artifacts/,
    );

    rmSync(join(directory, 'persistence'), { recursive: true, force: true });
    mkdirSync(join(directory, '__tests__'));
    writeFileSync(
      join(directory, '__tests__/provider.js'),
      'export const ok=1',
    );
    assert.throws(
      () => verifyProductionBuild(directory),
      /test-only database artifacts/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
