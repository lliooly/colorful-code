import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import ts from 'typescript';
import type { ZodType } from 'zod';

import {
  httpContractRegistry,
  type HttpContractDescriptor,
  type HttpContractRegistry,
} from '@colorful-code/schema/commands';

type SchemaFixture = Readonly<{
  path?: Readonly<Record<string, unknown>>;
  query?: Readonly<Record<string, unknown>>;
  body?: Readonly<Record<string, unknown>>;
}>;

const commandId = 'command-1';
const threadPath = { threadId: 'thread-1' };
const runPath = { ...threadPath, runId: 'run-1' };
const queueItemPath = { ...threadPath, queueItemId: 'queue-item-1' };
const textInput = { content: { kind: 'text', text: 'hello' } };
const acceptedAt = '2026-07-16T09:30:00+08:00';

const canonicalOperationAck = {
  commandId,
  operationId: 'operation-1',
  status: 'accepted',
  replayed: false,
  threadId: 'thread-1',
  runId: 'run-1',
  completionEvents: ['operation.completed'],
  currentDurableCursor: '7',
  acceptedAt,
} as const;

const fixtures = {
  'thread.create': { body: { commandId } },
  'thread.list': { query: {} },
  'thread.get': { path: threadPath, query: {} },
  'thread.patch': {
    path: threadPath,
    body: {
      commandId,
      expectedThreadRevision: 1,
      patch: { title: 'Renamed' },
    },
  },
  'thread.delete': {
    path: threadPath,
    body: { commandId, expectedThreadRevision: 1 },
  },
  'thread.resume': {
    path: threadPath,
    body: { commandId, expectedThreadRevision: 1 },
  },
  'thread.archive': {
    path: threadPath,
    body: { commandId, expectedThreadRevision: 1 },
  },
  'thread.unarchive': {
    path: threadPath,
    body: { commandId, expectedThreadRevision: 1 },
  },
  'thread.undelete': {
    path: threadPath,
    body: { commandId, expectedThreadRevision: 1 },
  },
  'thread.fork': {
    path: threadPath,
    body: {
      commandId,
      expectedThreadRevision: 1,
      boundary: { kind: 'latestCommitted' },
    },
  },
  'submission.create': {
    path: threadPath,
    body: { commandId, input: textInput, disposition: 'auto' },
  },
  'run.list': { path: threadPath, query: {} },
  'run.get': { path: runPath, query: {} },
  'run.steer': {
    path: runPath,
    body: {
      commandId,
      expectedPlanGeneration: 1,
      targetConfigRevision: 1,
      expectedPolicyRevision: 1,
      input: textInput,
    },
  },
  'run.stop': { path: runPath, body: { commandId } },
  'queue.get': { path: threadPath, query: {} },
  'queue.item.patch': {
    path: queueItemPath,
    body: {
      commandId,
      expectedQueueRevision: 1,
      expectedItemRevision: 1,
      input: textInput,
    },
  },
  'queue.item.delete': {
    path: queueItemPath,
    body: { commandId, expectedQueueRevision: 1 },
  },
  'queue.reorder': {
    path: threadPath,
    body: {
      commandId,
      expectedQueueRevision: 1,
      queueItemId: 'queue-item-1',
      beforeItemId: 'queue-item-2',
    },
  },
  'queue.pause': {
    path: threadPath,
    body: { commandId, expectedQueueRevision: 1 },
  },
  'queue.resume': {
    path: threadPath,
    body: { commandId, expectedQueueRevision: 1 },
  },
  'approval.decide': {
    path: { ...runPath, approvalId: 'approval-1' },
    body: {
      commandId,
      expectedPlanGeneration: 1,
      expectedApprovalRevision: 1,
      decision: 'approve',
    },
  },
  'config.change': {
    path: threadPath,
    body: {
      commandId,
      expectedConfigRevision: 1,
      patch: { model: 'gpt-example' },
    },
  },
  'policy.change': {
    path: threadPath,
    body: {
      commandId,
      expectedPolicyRevision: 1,
      patch: { workspaceTrust: 'trusted' },
    },
  },
  'operation.list': { path: threadPath, query: {} },
  'operation.get': {
    path: { ...threadPath, operationId: 'operation-1' },
    query: {},
  },
  'checkpoint.list': { path: threadPath, query: {} },
  'checkpoint.apply': {
    path: { ...threadPath, checkpointId: 'checkpoint-1' },
    body: {
      commandId,
      expectedThreadRevision: 1,
      expectedCheckpointRevision: 1,
    },
  },
  'snapshot.get': { path: threadPath, query: {} },
  'event.attach': { path: threadPath, query: {} },
} as const satisfies Readonly<
  Record<keyof HttpContractRegistry, SchemaFixture>
>;

const forbiddenBodyFields = [
  'clientIdentity',
  'payloadHash',
  'leaseEpoch',
  'workerId',
  'secret',
  'unknown',
] as const;

const forbiddenParameterFields = forbiddenBodyFields;

const fenceFields = {
  'thread.patch': ['expectedThreadRevision'],
  'thread.delete': ['expectedThreadRevision'],
  'thread.resume': ['expectedThreadRevision'],
  'thread.archive': ['expectedThreadRevision'],
  'thread.unarchive': ['expectedThreadRevision'],
  'thread.undelete': ['expectedThreadRevision'],
  'thread.fork': ['expectedThreadRevision'],
  'run.steer': [
    'expectedPlanGeneration',
    'targetConfigRevision',
    'expectedPolicyRevision',
  ],
  'queue.item.patch': ['expectedQueueRevision', 'expectedItemRevision'],
  'queue.item.delete': ['expectedQueueRevision'],
  'queue.reorder': ['expectedQueueRevision'],
  'queue.pause': ['expectedQueueRevision'],
  'queue.resume': ['expectedQueueRevision'],
  'approval.decide': ['expectedPlanGeneration', 'expectedApprovalRevision'],
  'config.change': ['expectedConfigRevision'],
  'policy.change': ['expectedPolicyRevision'],
  'checkpoint.apply': ['expectedThreadRevision', 'expectedCheckpointRevision'],
} as const satisfies Partial<
  Record<keyof HttpContractRegistry, readonly string[]>
>;

const schema = (value: ZodType | undefined): ZodType => {
  expect(value).toBeDefined();
  if (value === undefined) throw new Error('expected endpoint schema');
  return value;
};

describe('canonical mutation responses', () => {
  test('every mutation result schema parses a complete asynchronous command Ack', () => {
    for (const descriptor of Object.values(httpContractRegistry)) {
      if (descriptor.method === 'GET') continue;

      expect(descriptor.resultSchema.parse(canonicalOperationAck)).toEqual(
        canonicalOperationAck,
      );
    }
  });

  test('a mutation Ack can carry a synchronous result without an operation id', () => {
    const synchronousAck = {
      commandId,
      status: 'accepted',
      replayed: false,
      threadId: 'thread-1',
      currentDurableCursor: '8',
      acceptedAt,
      result: { configRevision: 2 },
    } as const;

    expect(
      httpContractRegistry['config.change'].resultSchema.parse(synchronousAck),
    ).toEqual(synchronousAck);
  });
});

const entries = Object.entries(httpContractRegistry) as Array<
  [keyof HttpContractRegistry, HttpContractDescriptor]
>;

const callableInitializer = (
  initializer: ts.Expression | undefined,
): initializer is ts.ArrowFunction | ts.FunctionExpression =>
  initializer !== undefined &&
  (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer));

const hasModifier = (node: ts.Node, kind: ts.SyntaxKind): boolean =>
  ts.canHaveModifiers(node) &&
  (ts.getModifiers(node)?.some((modifier) => modifier.kind === kind) ?? false);

const unsafeRegistryInitialization = (sourceText: string): string[] => {
  const fileName = '/commands.ts';
  const options: ts.CompilerOptions = {
    module: ts.ModuleKind.ESNext,
    noLib: true,
    noResolve: true,
    target: ts.ScriptTarget.Latest,
  };
  const sourceFile = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const host = ts.createCompilerHost(options);
  host.getSourceFile = (requested) =>
    requested === fileName ? sourceFile : undefined;
  host.fileExists = (requested) => requested === fileName;
  host.readFile = (requested) =>
    requested === fileName ? sourceText : undefined;
  host.writeFile = () => undefined;
  const checker = ts.createProgram([fileName], options, host).getTypeChecker();
  const violations: string[] = [];
  const callableNames = new Set<string>();
  const registryDeclarations: ts.VariableDeclaration[] = [];
  const defineFunctions: ts.FunctionLikeDeclaration[] = [];
  let defineSymbol: ts.Symbol | undefined;

  for (const statement of sourceFile.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      statement.importClause === undefined
    ) {
      violations.push('IMPORT_SIDE_EFFECT');
    }
    if (ts.isFunctionDeclaration(statement)) {
      const name = statement.name?.text;
      if (name !== undefined) callableNames.add(name);
      if (name === 'defineRegistry') {
        defineSymbol = checker.getSymbolAtLocation(statement.name!);
        defineFunctions.push(statement);
      }
      if (hasModifier(statement, ts.SyntaxKind.ExportKeyword)) {
        violations.push(`EXPORTED_CALLABLE:${name ?? '<anonymous>'}`);
      }
    }
    if (ts.isVariableStatement(statement)) {
      const exported = hasModifier(statement, ts.SyntaxKind.ExportKeyword);
      const constant =
        (statement.declarationList.flags & ts.NodeFlags.Const) !== 0;
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name)) continue;
        const name = declaration.name.text;
        if (callableInitializer(declaration.initializer)) {
          callableNames.add(name);
          if (name === 'defineRegistry') {
            defineSymbol = checker.getSymbolAtLocation(declaration.name);
            defineFunctions.push(declaration.initializer);
          }
          if (exported) violations.push(`EXPORTED_CALLABLE:${name}`);
        }
        if (name === 'httpContractRegistry' && exported && constant) {
          registryDeclarations.push(declaration);
        }
      }
    }
  }

  for (const statement of sourceFile.statements) {
    if (
      ts.isExportDeclaration(statement) &&
      statement.moduleSpecifier === undefined &&
      statement.exportClause !== undefined &&
      ts.isNamedExports(statement.exportClause)
    ) {
      for (const element of statement.exportClause.elements) {
        const local = element.propertyName?.text ?? element.name.text;
        if (callableNames.has(local)) {
          violations.push(`EXPORTED_CALLABLE:${element.name.text}`);
        }
      }
    }
    if (ts.isExportAssignment(statement)) {
      if (callableInitializer(statement.expression)) {
        violations.push('EXPORTED_CALLABLE:<default>');
      } else if (
        ts.isIdentifier(statement.expression) &&
        callableNames.has(statement.expression.text)
      ) {
        violations.push(`EXPORTED_CALLABLE:${statement.expression.text}`);
      }
    }
  }

  if (registryDeclarations.length !== 1) {
    violations.push(
      `REGISTRY_DECLARATION_COUNT:${registryDeclarations.length}`,
    );
  }
  if (defineFunctions.length !== 1 || defineSymbol === undefined) {
    violations.push(
      `DEFINE_REGISTRY_DEFINITION_COUNT:${defineFunctions.length}`,
    );
  }
  const registryDeclaration = registryDeclarations[0];
  if (registryDeclaration !== undefined) {
    const initializer = registryDeclaration.initializer;
    if (
      initializer === undefined ||
      !ts.isCallExpression(initializer) ||
      !ts.isIdentifier(initializer.expression) ||
      checker.getSymbolAtLocation(initializer.expression) !== defineSymbol ||
      initializer.arguments.length !== 1 ||
      !ts.isObjectLiteralExpression(initializer.arguments[0])
    ) {
      violations.push('REGISTRY_INITIALIZER_SHAPE');
    }
  }

  let defineCalls = 0;
  const countDefineCalls = (node: ts.Node): void => {
    if (
      defineSymbol !== undefined &&
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      checker.getSymbolAtLocation(node.expression) === defineSymbol
    ) {
      defineCalls += 1;
    }
    ts.forEachChild(node, countDefineCalls);
  };
  countDefineCalls(sourceFile);
  if (defineCalls !== 1) {
    violations.push(`DEFINE_REGISTRY_CALL_COUNT:${defineCalls}`);
  }

  const aliases = new Set<ts.Symbol>();
  if (registryDeclaration !== undefined) {
    const symbol = checker.getSymbolAtLocation(registryDeclaration.name);
    if (symbol !== undefined) aliases.add(symbol);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const statement of sourceFile.statements) {
      if (!ts.isVariableStatement(statement)) continue;
      const constant =
        (statement.declarationList.flags & ts.NodeFlags.Const) !== 0;
      for (const declaration of statement.declarationList.declarations) {
        if (
          !ts.isIdentifier(declaration.name) ||
          declaration.initializer === undefined ||
          !ts.isIdentifier(declaration.initializer)
        ) {
          continue;
        }
        const source = checker.getSymbolAtLocation(declaration.initializer);
        const alias = checker.getSymbolAtLocation(declaration.name);
        if (
          source !== undefined &&
          alias !== undefined &&
          aliases.has(source) &&
          !aliases.has(alias)
        ) {
          aliases.add(alias);
          if (!constant) {
            violations.push(`REGISTRY_WRITABLE_ALIAS:${declaration.name.text}`);
          }
          changed = true;
        }
      }
    }
  }

  const isAlias = (expression: ts.Expression): boolean => {
    let current = expression;
    while (
      ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isNonNullExpression(current)
    ) {
      current = current.expression;
    }
    const symbol = ts.isIdentifier(current)
      ? checker.getSymbolAtLocation(current)
      : undefined;
    return symbol !== undefined && aliases.has(symbol);
  };

  const visitWrites = (node: ts.Node): void => {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    ) {
      if (ts.isIdentifier(node.left) && isAlias(node.left)) {
        violations.push(`REGISTRY_ALIAS_REASSIGN:${node.left.text}`);
      }
      if (
        (ts.isPropertyAccessExpression(node.left) ||
          ts.isElementAccessExpression(node.left)) &&
        isAlias(node.left.expression)
      ) {
        violations.push(`REGISTRY_ALIAS_PROPERTY_WRITE:${node.left.getText()}`);
      }
    }
    if (
      ts.isDeleteExpression(node) &&
      (ts.isPropertyAccessExpression(node.expression) ||
        ts.isElementAccessExpression(node.expression)) &&
      isAlias(node.expression.expression)
    ) {
      violations.push(`REGISTRY_ALIAS_DELETE:${node.expression.getText()}`);
    }
    if (ts.isCallExpression(node)) {
      if (
        ts.isPropertyAccessExpression(node.expression) &&
        isAlias(node.expression.expression) &&
        ['set', 'delete', 'clear'].includes(node.expression.name.text)
      ) {
        violations.push(`REGISTRY_ALIAS_MUTATION:${node.expression.name.text}`);
      }
      if (
        ts.isElementAccessExpression(node.expression) &&
        isAlias(node.expression.expression) &&
        ts.isStringLiteral(node.expression.argumentExpression) &&
        ['set', 'delete', 'clear'].includes(
          node.expression.argumentExpression.text,
        )
      ) {
        violations.push(
          `REGISTRY_ALIAS_MUTATION:${node.expression.argumentExpression.text}`,
        );
      }
      if (ts.isPropertyAccessExpression(node.expression)) {
        const owner = node.expression.expression.getText();
        const method = node.expression.name.text;
        const firstArgument = node.arguments[0];
        if (
          firstArgument !== undefined &&
          isAlias(firstArgument) &&
          ((owner === 'Object' &&
            ['assign', 'defineProperty'].includes(method)) ||
            (owner === 'Reflect' && ['set', 'deleteProperty'].includes(method)))
        ) {
          violations.push(`REGISTRY_ALIAS_MUTATION:${owner}.${method}`);
        }
      }
      for (const argument of node.arguments) {
        if (isAlias(argument)) {
          violations.push(
            `REGISTRY_ALIAS_ARGUMENT:${node.expression.getText()}`,
          );
        }
      }
    }
    ts.forEachChild(node, visitWrites);
  };
  visitWrites(sourceFile);

  const defineFunction = defineFunctions[0];
  if (defineFunction !== undefined) {
    const visitDefine = (node: ts.Node): void => {
      if (hasModifier(node, ts.SyntaxKind.AsyncKeyword)) {
        violations.push('DEFINE_REGISTRY_ASYNC');
      }
      if (ts.isAwaitExpression(node)) violations.push('DEFINE_REGISTRY_AWAIT');
      if (ts.isNewExpression(node)) violations.push('DEFINE_REGISTRY_NEW');
      if (
        ts.isIdentifier(node) &&
        (node.text === 'Promise' || node.text === 'Map')
      ) {
        violations.push(`DEFINE_REGISTRY_FORBIDDEN_GLOBAL:${node.text}`);
      }
      if (ts.isCallExpression(node)) {
        const call = node.expression.getText();
        if (!['Object.values', 'Object.freeze'].includes(call)) {
          violations.push(`DEFINE_REGISTRY_CALL:${call}`);
        }
      }
      ts.forEachChild(node, visitDefine);
    };
    visitDefine(defineFunction);
  }
  return violations;
};

const withoutField = (
  value: Readonly<Record<string, unknown>>,
  field: string,
): Record<string, unknown> => {
  const candidate = { ...value };
  delete candidate[field];
  expect(candidate).toEqual(
    Object.fromEntries(Object.entries(value).filter(([key]) => key !== field)),
  );
  return candidate;
};

const withOnlyInjectedFieldChanged = (
  value: Readonly<Record<string, unknown>>,
  field: string,
): Record<string, unknown> => {
  expect(value).not.toHaveProperty(field);
  const candidate = { ...value, [field]: 'forbidden' };
  expect(withoutField(candidate, field)).toEqual(value);
  return candidate;
};

describe('complete HTTP command invariants', () => {
  test('covers all 30 endpoints with an exact successful fixture per declared schema', () => {
    expect(entries).toHaveLength(30);
    expect(Object.keys(fixtures).sort()).toEqual(
      Object.keys(httpContractRegistry).sort(),
    );

    for (const [operationId, descriptor] of entries) {
      const fixture = fixtures[operationId];
      const fixtureSchemaKeys = Object.keys(fixture).sort();
      const descriptorSchemaKeys = (['path', 'query', 'body'] as const)
        .filter((kind) => descriptor[`${kind}Schema`] !== undefined)
        .sort();

      expect(fixtureSchemaKeys).toEqual(descriptorSchemaKeys);
      for (const kind of descriptorSchemaKeys) {
        const baseline = fixture[kind];
        expect(baseline).toBeDefined();
        expect(
          schema(descriptor[`${kind}Schema`]).safeParse(baseline).success,
        ).toBe(true);
      }
    }
  });

  test('strictly rejects server-owned top-level fields in every body, path and query', () => {
    for (const [operationId, descriptor] of entries) {
      const fixture = fixtures[operationId];

      if (fixture.body !== undefined) {
        const bodySchema = schema(descriptor.bodySchema);
        expect(bodySchema.safeParse(fixture.body).success).toBe(true);
        for (const field of forbiddenBodyFields) {
          expect(bodySchema.safeParse(fixture.body).success).toBe(true);
          const candidate = withOnlyInjectedFieldChanged(fixture.body, field);
          expect(bodySchema.safeParse(candidate).success).toBe(false);
        }
      }

      for (const kind of ['path', 'query'] as const) {
        const baseline = fixture[kind];
        if (baseline === undefined) continue;
        const parameterSchema = schema(descriptor[`${kind}Schema`]);
        expect(parameterSchema.safeParse(baseline).success).toBe(true);
        for (const field of forbiddenParameterFields) {
          expect(parameterSchema.safeParse(baseline).success).toBe(true);
          const candidate = withOnlyInjectedFieldChanged(baseline, field);
          expect(parameterSchema.safeParse(candidate).success).toBe(false);
        }
      }
    }
  });

  test('requires commandId on every mutation and forbids bodies on GET endpoints', () => {
    for (const [operationId, descriptor] of entries) {
      const fixture = fixtures[operationId];
      if (descriptor.method === 'GET') {
        expect(descriptor.bodySchema).toBeUndefined();
        expect(fixture.body).toBeUndefined();
        continue;
      }

      expect(fixture.body).toBeDefined();
      const baseline = fixture.body ?? {};
      const bodySchema = schema(descriptor.bodySchema);
      expect(bodySchema.safeParse(baseline).success).toBe(true);
      expect(baseline).toHaveProperty('commandId');
      expect(
        bodySchema.safeParse(withoutField(baseline, 'commandId')).success,
      ).toBe(false);
    }
  });

  test('requires every normative optimistic-concurrency fence', () => {
    for (const [operationId, fields] of Object.entries(fenceFields) as Array<
      [keyof typeof fenceFields, readonly string[]]
    >) {
      const descriptor = httpContractRegistry[operationId];
      const baseline = fixtures[operationId].body;
      expect(baseline).toBeDefined();
      const bodySchema = schema(descriptor.bodySchema);

      for (const field of fields) {
        expect(bodySchema.safeParse(baseline).success).toBe(true);
        expect(baseline).toHaveProperty(field);
        expect(
          bodySchema.safeParse(withoutField(baseline ?? {}, field)).success,
        ).toBe(false);
      }
    }
  });
});

describe('HTTP registry initialization and concurrency invariants', () => {
  test('shallow-freezes registry metadata containers without route collisions', () => {
    expect(Object.isFrozen(httpContractRegistry)).toBe(true);
    const methodPaths = new Set<string>();

    for (const [operationId, descriptor] of entries) {
      expect(Object.isFrozen(descriptor)).toBe(true);
      expect(descriptor.operationId).toBe(operationId);

      const expectedKeys = [
        'method',
        'path',
        'operationId',
        ...Object.keys(fixtures[operationId]).map((kind) => `${kind}Schema`),
        'resultSchema',
        'responseKind',
      ].sort();
      expect(Object.keys(descriptor).sort()).toEqual(expectedKeys);
      expect(
        Object.values(descriptor).some((value) => typeof value === 'function'),
      ).toBe(false);

      const methodPath = `${descriptor.method} ${descriptor.path}`;
      expect(methodPaths.has(methodPath)).toBe(false);
      methodPaths.add(methodPath);
    }
  });

  test('has one synchronous registry construction with no writable aliases', async () => {
    const commandsSource = await Bun.file(
      resolve(import.meta.dir, '../src/commands.ts'),
    ).text();
    const defineRegistrySource = `
      const defineRegistry = (registry) => {
        for (const descriptor of Object.values(registry)) Object.freeze(descriptor);
        return Object.freeze(registry);
      };
    `;
    const baseline = `${defineRegistrySource}
      export const httpContractRegistry = defineRegistry({});
    `;

    const redProbes = [
      {
        source: `${baseline} import "./setup.js";`,
        expected: 'IMPORT_SIDE_EFFECT',
      },
      {
        source: `${defineRegistrySource} export const httpContractRegistry = {};`,
        expected: 'REGISTRY_INITIALIZER_SHAPE',
      },
      {
        source: `${baseline} const duplicate = defineRegistry({});`,
        expected: 'DEFINE_REGISTRY_CALL_COUNT:2',
      },
      {
        source: `${baseline} export const addEndpoint = () => undefined;`,
        expected: 'EXPORTED_CALLABLE:addEndpoint',
      },
      {
        source: `${baseline} const alias = httpContractRegistry; alias = {};`,
        expected: 'REGISTRY_ALIAS_REASSIGN:alias',
      },
      {
        source: `${baseline} let alias = httpContractRegistry; alias.extra = {};`,
        expected: 'REGISTRY_WRITABLE_ALIAS:alias',
      },
      {
        source: `${baseline} const alias = httpContractRegistry; alias.extra = {};`,
        expected: 'REGISTRY_ALIAS_PROPERTY_WRITE',
      },
      {
        source: `${baseline} const alias = httpContractRegistry; alias["extra"] = {};`,
        expected: 'REGISTRY_ALIAS_PROPERTY_WRITE',
      },
      {
        source: `${baseline} const alias = httpContractRegistry; delete alias.extra;`,
        expected: 'REGISTRY_ALIAS_DELETE',
      },
      {
        source: `${baseline} const alias = httpContractRegistry; alias.set("x", 1);`,
        expected: 'REGISTRY_ALIAS_MUTATION:set',
      },
      {
        source: `${baseline} const alias = httpContractRegistry; Object.assign(alias, {});`,
        expected: 'REGISTRY_ALIAS_MUTATION:Object.assign',
      },
      {
        source: `import { register } from "./router.js"; ${baseline}
          const alias = httpContractRegistry; register(alias);`,
        expected: 'REGISTRY_ALIAS_ARGUMENT:register',
      },
      {
        source: `import { register } from "./router.js"; ${baseline}
          const first = httpContractRegistry; const second = first; register(second);`,
        expected: 'REGISTRY_ALIAS_ARGUMENT:register',
      },
      {
        source: `const defineRegistry = async (registry) => Object.freeze(registry);
          export const httpContractRegistry = defineRegistry({});`,
        expected: 'DEFINE_REGISTRY_ASYNC',
      },
      {
        source: `const defineRegistry = async (registry) => { await load(); return Object.freeze(registry); };
          export const httpContractRegistry = defineRegistry({});`,
        expected: 'DEFINE_REGISTRY_AWAIT',
      },
      {
        source: `const defineRegistry = (registry) => { new Date(); return Object.freeze(registry); };
          export const httpContractRegistry = defineRegistry({});`,
        expected: 'DEFINE_REGISTRY_NEW',
      },
      {
        source: `const defineRegistry = (registry) => { Promise.resolve(); return Object.freeze(registry); };
          export const httpContractRegistry = defineRegistry({});`,
        expected: 'DEFINE_REGISTRY_FORBIDDEN_GLOBAL:Promise',
      },
      {
        source: `const defineRegistry = (registry) => { const map = new Map(); return Object.freeze(registry); };
          export const httpContractRegistry = defineRegistry({});`,
        expected: 'DEFINE_REGISTRY_FORBIDDEN_GLOBAL:Map',
      },
      {
        source: `const helper = (value) => value;
          const defineRegistry = (registry) => helper(registry);
          export const httpContractRegistry = defineRegistry({});`,
        expected: 'DEFINE_REGISTRY_CALL:helper',
      },
    ] as const;

    for (const { source, expected } of redProbes) {
      const violations = unsafeRegistryInitialization(source);
      if (!violations.some((violation) => violation.startsWith(expected))) {
        throw new Error(
          `red probe did not produce ${expected}: ${source}; got ${violations.join(', ')}`,
        );
      }
    }
    for (const safeProbe of [
      `${baseline} const helper = (value) => ({ value });`,
      `${baseline} export { someSchema } from "./schema.js";`,
      `${baseline} const helper = () => { const map = new Map(); map.set("x", 1); };`,
      `${baseline} const helper = () => { const set = new Set(); set.add("x"); };`,
      `${baseline} const custom = { set() {} }; custom.set();`,
    ]) {
      expect(unsafeRegistryInitialization(safeProbe)).toEqual([]);
    }
    expect(unsafeRegistryInitialization(commandsSource)).toEqual([]);
  });
});
