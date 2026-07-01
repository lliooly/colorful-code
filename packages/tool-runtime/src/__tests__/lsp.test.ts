import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import {
  ToolRegistry,
  ToolRunner,
  SdkLspManager,
  createLspRuntimeTools,
  createRuntimeContext,
  type LspManager,
} from '../index.js';

const fixtureConfig = {
  fixture: {
    command: process.execPath,
    args: [join(process.cwd(), 'src/__tests__/fixtures/lsp-stdio-server.mjs')],
    language: 'typescript',
    fileExtensions: ['.ts', '.tsx'],
  },
};

test('SdkLspManager initializes stdio servers and exposes connection status', async () => {
  const manager = new SdkLspManager(fixtureConfig);
  try {
    const connections = await manager.initialize(process.cwd());
    assert.equal(connections[0]?.type, 'connected');
    assert.equal(connections[0]?.language, 'typescript');
    assert.equal(
      connections[0]?.capabilities.definitionProvider,
      true,
    );
  } finally {
    await manager.close();
  }
});

test('SdkLspManager opens documents lazily and queries LSP features', async () => {
  const manager = new SdkLspManager(fixtureConfig);
  try {
    await manager.initialize(process.cwd());
    const file = join(process.cwd(), 'src/__tests__/sample.ts');
    const definitions = await manager.goToDefinition(file, 0, 1);
    const references = await manager.findReferences(file, 0, 1);
    const hover = await manager.hover(file, 0, 1);
    const symbols = await manager.documentSymbols(file);

    assert.equal(definitions[0]?.range.start.line, 2);
    assert.equal(references.length, 2);
    assert.match(JSON.stringify(hover?.contents), /fixtureHover/);
    assert.equal(symbols[0]?.name, 'fixtureSymbol');
  } finally {
    await manager.close();
  }
});

test('SdkLspManager sends full-document didChange updates', async () => {
  const manager = new SdkLspManager(fixtureConfig);
  try {
    await manager.initialize(process.cwd());
    const file = join(process.cwd(), 'src/__tests__/sample.ts');
    await manager.didChange(file, 'const broken = true;\n');
    const diagnostics = await manager.getDiagnostics(file);

    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0]?.message, 'Found broken text');
  } finally {
    await manager.close();
  }
});

test('LSP tools call context.lspManager and format results', async () => {
  const fakeManager: LspManager = {
    async initialize() {
      return [];
    },
    async goToDefinition(file) {
      return [
        {
          uri: new URL('file://' + process.cwd() + '/' + file).href,
          range: {
            start: { line: 4, character: 2 },
            end: { line: 4, character: 8 },
          },
        },
      ];
    },
    async findReferences() {
      return [];
    },
    async getDiagnostics() {
      return [
        {
          range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 1 },
          },
          message: 'type mismatch',
          severity: 1,
        },
      ];
    },
    async hover() {
      return { contents: 'const answer: number' };
    },
    async documentSymbols() {
      return [
        {
          name: 'answer',
          kind: 13,
          range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 12 },
          },
          selectionRange: {
            start: { line: 0, character: 6 },
            end: { line: 0, character: 12 },
          },
        },
      ];
    },
    async workspaceSymbol() {
      return [];
    },
    async didChange() {},
    async close() {},
  };

  const runner = new ToolRunner(
    new ToolRegistry(await createLspRuntimeTools()),
    createRuntimeContext({ lspManager: fakeManager }),
  );

  const definition = await runner.run({
    id: 'def',
    name: 'LSPGoToDefinition',
    input: { file: 'src/sample.ts', line: 0, character: 1 },
  });
  const hover = await runner.run({
    id: 'hover',
    name: 'LSPHover',
    input: { file: 'src/sample.ts', line: 0, character: 1 },
  });
  const diagnostics = await runner.run({
    id: 'diag',
    name: 'LSPDiagnostics',
    input: { file: 'src/sample.ts' },
  });

  assert.equal(definition.isError, undefined);
  assert.match(definition.content, /src\/sample\.ts:5:3/);
  assert.match(hover.content, /answer: number/);
  assert.match(diagnostics.content, /type mismatch/);
});

test('LSP tools return a friendly message when no manager is configured', async () => {
  const runner = new ToolRunner(
    new ToolRegistry(await createLspRuntimeTools()),
    createRuntimeContext(),
  );

  const result = await runner.run({
    id: 'missing',
    name: 'LSPGoToDefinition',
    input: { file: 'src/sample.ts', line: 0, character: 1 },
  });

  assert.equal(result.isError, undefined);
  assert.equal(result.content, 'No LSP server configured for .ts');
});

test('createLspRuntimeTools returns the five LSP tools', async () => {
  const tools = await createLspRuntimeTools();
  assert.deepEqual(
    tools.map((tool) => tool.name).sort(),
    [
      'LSPDiagnostics',
      'LSPDocumentSymbols',
      'LSPFindReferences',
      'LSPGoToDefinition',
      'LSPHover',
    ],
  );
});
