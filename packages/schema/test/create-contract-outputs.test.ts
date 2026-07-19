import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  GENERATED_PATHS,
  createContractOutputs,
  validateContractOutputs,
  type ContractOutputs,
} from '../scripts/create-contract-outputs.js';

const withOutput = (
  outputs: ContractOutputs,
  path: (typeof GENERATED_PATHS)[number],
  contents: string,
): ContractOutputs => ({ ...outputs, [path]: contents });

describe('createContractOutputs', () => {
  test('returns exactly the declared generated paths in stable order', () => {
    const outputs = createContractOutputs();

    expect(Object.keys(outputs)).toEqual([...GENERATED_PATHS]);
    expect(Object.isFrozen(outputs)).toBe(true);
  });

  test('creates byte-identical deterministic output on every call', () => {
    const first = createContractOutputs();
    const second = createContractOutputs();

    for (const path of GENERATED_PATHS) {
      expect(Buffer.from(first[path]).equals(Buffer.from(second[path]))).toBe(
        true,
      );
    }
  });

  test('emits parseable JSON and preserves generated source headers', () => {
    const outputs = createContractOutputs();

    expect(() => JSON.parse(outputs['generated/openapi.v2.json'])).not.toThrow();
    expect(() =>
      JSON.parse(outputs['generated/events.schema.json']),
    ).not.toThrow();
    expect(outputs['generated/typescript/contracts.ts']).toStartWith(
      '// This file is generated.',
    );
    expect(
      outputs[
        'swift-fixture/Sources/ColorfulCodeContracts/ColorfulCodeContracts.swift'
      ],
    ).toStartWith('// This file is generated.');
  });

  test('rejects malformed JSON artifacts before publication', () => {
    const outputs = createContractOutputs();

    expect(() =>
      validateContractOutputs(
        withOutput(outputs, 'generated/openapi.v2.json', '{'),
      ),
    ).toThrow(SyntaxError);
    expect(() =>
      validateContractOutputs(
        withOutput(outputs, 'generated/events.schema.json', '{'),
      ),
    ).toThrow(SyntaxError);
  });

  test('rejects generated sources whose defensive headers are missing', () => {
    const outputs = createContractOutputs();

    expect(() =>
      validateContractOutputs(
        withOutput(outputs, 'generated/typescript/contracts.ts', 'export {};'),
      ),
    ).toThrow('generated TypeScript artifact failed validation');
    expect(() =>
      validateContractOutputs(
        withOutput(
          outputs,
          'swift-fixture/Sources/ColorfulCodeContracts/ColorfulCodeContracts.swift',
          'public struct Contract {}',
        ),
      ),
    ).toThrow('generated Swift artifact failed validation');
  });

  test('keeps the generation kernel free of runtime and I/O dependencies', () => {
    const source = readFileSync(
      resolve(import.meta.dir, '../scripts/create-contract-outputs.ts'),
      'utf8',
    );

    for (const forbiddenImport of [
      'bun:ffi',
      'node:fs',
      'node:os',
      'node:perf_hooks',
      'generate.ts',
    ]) {
      expect(source).not.toContain(forbiddenImport);
    }
    expect(source).toContain('validateContractOutputs(outputs);');
  });
});
