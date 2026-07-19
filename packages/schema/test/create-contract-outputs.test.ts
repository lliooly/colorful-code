import { describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import ts from 'typescript';

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

const failPurityAudit = (path: string, rule: string): never => {
  throw new Error(`${path}: ${rule}`);
};

const resolveFirstPartyModule = (
  importerPath: string,
  specifier: string,
): string => {
  const importedPath = resolve(dirname(importerPath), specifier);
  const candidates = specifier.endsWith('.js')
    ? [`${importedPath.slice(0, -3)}.ts`]
    : specifier.endsWith('.ts')
      ? [importedPath]
      : [`${importedPath}.ts`, join(importedPath, 'index.ts')];
  const resolvedPath = candidates.find(existsSync);
  if (resolvedPath === undefined) {
    failPurityAudit(importerPath, 'unresolved relative import/export');
  }
  return resolvedPath;
};

const auditPureModuleGraph = (entryPath: string): void => {
  const auditedPaths = new Set<string>();
  const auditFile = (path: string): void => {
    if (auditedPaths.has(path)) return;
    auditedPaths.add(path);
    const source = ts.createSourceFile(
      path,
      readFileSync(path, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const dependencies: string[] = [];

    for (const statement of source.statements) {
      if (
        ts.isVariableStatement(statement) &&
        (statement.declarationList.flags & ts.NodeFlags.Const) === 0
      ) {
        failPurityAudit(path, 'top-level let/var');
      }
      if (
        (ts.isImportDeclaration(statement) ||
          ts.isExportDeclaration(statement)) &&
        statement.moduleSpecifier !== undefined &&
        ts.isStringLiteral(statement.moduleSpecifier)
      ) {
        const specifier = statement.moduleSpecifier.text;
        if (/^(?:node:|bun:)/u.test(specifier)) {
          failPurityAudit(path, 'node:/bun: import');
        }
        if (specifier.startsWith('.')) {
          dependencies.push(resolveFirstPartyModule(path, specifier));
        }
      }
    }

    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword
      ) {
        failPurityAudit(path, 'dynamic import');
      }
      if (
        ts.isIdentifier(node) &&
        (node.text === 'process' || node.text === 'globalThis')
      ) {
        failPurityAudit(path, `${node.text} access`);
      }
      if (
        ts.isPropertyAccessExpression(node) &&
        ts.isIdentifier(node.expression) &&
        ((node.expression.text === 'Date' && node.name.text === 'now') ||
          (node.expression.text === 'Math' && node.name.text === 'random'))
      ) {
        failPurityAudit(path, `${node.expression.text}.${node.name.text}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    for (const dependency of dependencies) auditFile(dependency);
  };
  auditFile(resolve(entryPath));
};

const EXPECTED_GENERATED_PATHS = [
  'generated/openapi.v2.json',
  'generated/events.schema.json',
  'generated/typescript/contracts.ts',
  'swift-fixture/Sources/ColorfulCodeContracts/ColorfulCodeContracts.swift',
] as const;

describe('createContractOutputs', () => {
  test('returns exactly the declared generated paths in stable order', () => {
    const outputs = createContractOutputs();

    expect(Object.keys(outputs)).toEqual([...GENERATED_PATHS]);
    expect(Object.isFrozen(outputs)).toBe(true);
  });

  test('freezes the declared generated paths against runtime mutation', () => {
    const mutablePaths = GENERATED_PATHS as unknown as string[];

    expect(Object.isFrozen(GENERATED_PATHS)).toBe(true);
    expect(() => mutablePaths.push('generated/extra.ts')).toThrow(TypeError);
    expect(() => mutablePaths.splice(0, 1)).toThrow(TypeError);
    expect(Reflect.set(mutablePaths, 0, 'generated/replaced.ts')).toBe(false);
    expect(GENERATED_PATHS).toEqual(EXPECTED_GENERATED_PATHS);
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

  test('keeps the complete generation dependency graph pure', () => {
    expect(() =>
      auditPureModuleGraph(
        resolve(import.meta.dir, '../scripts/create-contract-outputs.ts'),
      ),
    ).not.toThrow();
  });

  test('reports an indirect first-party module that imports Node APIs', () => {
    const directory = mkdtempSync(join(tmpdir(), 'schema-purity-audit-'));
    try {
      const entry = join(directory, 'entry.ts');
      writeFileSync(entry, "export { child } from './child.js';\n");
      writeFileSync(
        join(directory, 'child.ts'),
        "import { readFileSync } from 'node:fs';\nexport const child = readFileSync;\n",
      );

      expect(() => auditPureModuleGraph(entry)).toThrow(
        /child\.ts: node:\/bun: import/u,
      );
    } finally {
      rmSync(directory, { recursive: true });
    }
  });

  test('typechecks the pure generation closure without the Bun publisher', () => {
    const config = JSON.parse(
      readFileSync(resolve(import.meta.dir, '../tsconfig.test.json'), 'utf8'),
    ) as { include: string[] };

    expect(config.include).toContain('scripts/create-contract-outputs.ts');
    expect(config.include).toContain('scripts/lib/**/*.ts');
    expect(config.include).not.toContain('scripts/generate.ts');
  });
});
