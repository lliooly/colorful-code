import { afterEach, describe, expect, test } from 'bun:test';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  bazelOutputCheckerTestSeams,
  checkBazelOutputs,
} from '../scripts/check-bazel-outputs.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const makeFixture = () => {
  const root = mkdtempSync(join(tmpdir(), 'bazel-output-check-'));
  temporaryDirectories.push(root);
  const outputs = {
    openapi: join(root, 'openapi.v2.json'),
    events: join(root, 'events.schema.json'),
    typescript: join(root, 'contracts.ts'),
    swift: join(root, 'ColorfulCodeContracts.swift'),
  } as const;
  const fixtures = {
    openapi: join(root, 'fixture-openapi.v2.json'),
    events: join(root, 'fixture-events.schema.json'),
    typescript: join(root, 'fixture-contracts.ts'),
    swift: join(root, 'fixture-ColorfulCodeContracts.swift'),
  } as const;
  for (const [name, path] of Object.entries(outputs))
    writeFileSync(path, `${name}\n`);
  for (const [name, path] of Object.entries(fixtures))
    writeFileSync(path, `${name}\n`);
  return { outputs, fixtures };
};

describe('checkBazelOutputs', () => {
  test('accepts exactly four byte-identical output/fixture pairs', () => {
    const { outputs, fixtures } = makeFixture();
    expect(checkBazelOutputs(outputs, fixtures)).toEqual({ ok: true });
  });

  test('reports a missing output using only its logical name and relative path', () => {
    const { outputs, fixtures } = makeFixture();
    rmSync(outputs.events);
    const result = checkBazelOutputs(outputs, fixtures);
    expect(result.ok).toBe(false);
    expect(result.diagnostic).toBe('events: missing output events.schema.json');
    expect(result.diagnostic).not.toContain('fixture');
  });

  test('reports byte drift without including payloads', () => {
    const { outputs, fixtures } = makeFixture();
    writeFileSync(outputs.typescript, 'secret output payload\n');
    writeFileSync(fixtures.typescript, 'secret fixture payload\n');
    const result = checkBazelOutputs(outputs, fixtures);
    expect(result).toEqual({
      ok: false,
      diagnostic: 'typescript: content differs contracts.ts',
    });
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  test('rejects an output set with more than four paths', () => {
    const { outputs, fixtures } = makeFixture();
    const extra = join(
      Object.values(outputs)[0]!.replace('openapi.v2.json', 'extra.txt'),
    );
    writeFileSync(extra, 'extra\n');
    expect(
      bazelOutputCheckerTestSeams.validateOutputSet(
        { ...outputs, extra },
        fixtures,
      ),
    ).toEqual('output count must be exactly four');
  });
});
