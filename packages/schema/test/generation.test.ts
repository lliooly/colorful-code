import { describe, expect, test } from 'bun:test';
import {
  linkSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  renameSync,
  readdirSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

import * as publicContracts from '../src/index.js';

const EXPECTED_SCHEMA_NAMES = [
  'ApiError',
  'ApiErrorPayload',
  'ApplyCheckpointBody',
  'ApprovalDecision',
  'ApprovalDecisionBody',
  'ApprovalDecisionPath',
  'ApprovalDecisionView',
  'ApprovalId',
  'ApprovalKind',
  'ApprovalStatus',
  'ApprovalView',
  'ArtifactId',
  'ArtifactReference',
  'ArtifactReferencesInputContent',
  'AssistantStreamBuffer',
  'AssistantTranscriptPayload',
  'AuthenticatedPrincipal',
  'AuthenticatedPrincipalKind',
  'CanonicalNonBlankString',
  'CheckpointId',
  'CheckpointPage',
  'CheckpointPath',
  'CheckpointSummary',
  'CommandId',
  'CompletedAssistantTranscriptPayload',
  'ConfigChangeBody',
  'ConfigPatch',
  'ConfigRevision',
  'ConfigRevisionResult',
  'ContextBoundaryId',
  'CreateSubmissionBody',
  'CreateThreadBody',
  'CredentialRef',
  'CredentialRefId',
  'CredentialRevokedEventPayload',
  'DaemonDiscovery',
  'DaemonEndpoint',
  'DaemonInstanceId',
  'DurableBasis',
  'DurableCursor',
  'EffectiveQueueDispatchState',
  'EmptyQuery',
  'ErrorCode',
  'ErrorHttpMapping',
  'EventAttachAcceptedResponse',
  'EventAttachParams',
  'EventAttachQuery',
  'EventAttachResetResponse',
  'EventAttachResponse',
  'EventBase',
  'EventId',
  'ForkBoundary',
  'ForkThreadBody',
  'HealthResponse',
  'IncarnationId',
  'InputContent',
  'InputItemId',
  'InputItemView',
  'InputRole',
  'InputSource',
  'InputTranscriptPayload',
  'InterruptedAssistantTranscriptPayload',
  'JsonObject',
  'JsonValue',
  'KnownDurableEventEnvelope',
  'KnownDurableEventPayload',
  'KnownThreadStreamFrame',
  'KnownTransientEventEnvelope',
  'KnownTransientEventPayload',
  'LineageId',
  'NetworkPolicy',
  'NewInputItem',
  'OperationCancelledEventPayload',
  'OperationCompletedEventPayload',
  'OperationCompletionEventKind',
  'OperationFailedEventPayload',
  'OperationId',
  'OperationKind',
  'OperationListQuery',
  'OperationPage',
  'OperationPath',
  'OperationProgress',
  'OperationStatus',
  'OperationTerminalEventPayload',
  'OperationTranscriptPayload',
  'OperationView',
  'PageCursor',
  'PageInfo',
  'PaginationQuery',
  'ParseThreadStreamFrameResult',
  'PatchQueueItemBody',
  'PatchQueueItemResult',
  'PatchThreadBody',
  'PlanGeneration',
  'PluginCapabilities',
  'PluginId',
  'PolicyChangeBody',
  'PolicyPatch',
  'PolicyRevision',
  'PolicyRevisionResult',
  'PrincipalId',
  'QueueControlState',
  'QueueItemId',
  'QueueItemPath',
  'QueueItemStatus',
  'QueueItemView',
  'QueueMutationBody',
  'QueueRevisionResult',
  'QueueView',
  'ReasoningEffort',
  'ReorderQueueBody',
  'ResetId',
  'Revision',
  'RunId',
  'RunKind',
  'RunPage',
  'RunPath',
  'RunStatus',
  'RunTerminalReason',
  'RunView',
  'SandboxPolicy',
  'SnapshotReset',
  'SnapshotResetKind',
  'SnapshotResetReason',
  'SteerRunBody',
  'SteerStalePolicy',
  'StopRunBody',
  'StreamBasis',
  'StreamCursor',
  'StreamInterruptionReason',
  'StreamStateSnapshot',
  'StreamStateStatus',
  'StreamingAssistantTranscriptPayload',
  'StructuredInputContent',
  'SubmissionDisposition',
  'SubmissionResult',
  'SystemTranscriptPayload',
  'TextInputContent',
  'ThreadId',
  'ThreadLifecycle',
  'ThreadLifecycleBody',
  'ThreadMetadataPatch',
  'ThreadPage',
  'ThreadPath',
  'ThreadRuntimeStatus',
  'ThreadSnapshot',
  'ThreadStreamFrame',
  'ThreadView',
  'Timestamp',
  'TokenRef',
  'ToolExecutionId',
  'ToolExecutionState',
  'ToolExecutionSummary',
  'ToolStreamBuffer',
  'ToolTranscriptPayload',
  'TranscriptItemId',
  'TranscriptItemKind',
  'TranscriptItemView',
  'TranscriptStatus',
  'UndefinedResult',
  'UnknownDurableEventEnvelope',
  'UnknownEventEnvelope',
  'UnknownTransientEventEnvelope',
  'WorkspaceBinding',
  'WorkspaceId',
  'WorkspaceTrust',
] as const;

const EXPECTED_HTTP_OPERATION_IDS = [
  'approval.decide',
  'checkpoint.apply',
  'checkpoint.list',
  'config.change',
  'event.attach',
  'operation.get',
  'operation.list',
  'policy.change',
  'queue.get',
  'queue.item.delete',
  'queue.item.patch',
  'queue.pause',
  'queue.reorder',
  'queue.resume',
  'run.get',
  'run.list',
  'run.steer',
  'run.stop',
  'snapshot.get',
  'submission.create',
  'thread.archive',
  'thread.create',
  'thread.delete',
  'thread.fork',
  'thread.get',
  'thread.list',
  'thread.patch',
  'thread.resume',
  'thread.unarchive',
  'thread.undelete',
] as const;

const EXPECTED_EVENT_SCHEMA_NAMES = [
  'KnownDurableEventEnvelope',
  'KnownThreadStreamFrame',
  'KnownTransientEventEnvelope',
  'SnapshotReset',
  'ThreadStreamFrame',
  'UnknownDurableEventEnvelope',
  'UnknownEventEnvelope',
  'UnknownTransientEventEnvelope',
] as const;

const compareText = (left: string, right: string) =>
  left < right ? -1 : left > right ? 1 : 0;

const collectJsonReferences = (value: unknown): string[] => {
  if (Array.isArray(value)) return value.flatMap(collectJsonReferences);
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, nested]) =>
    key === '$ref' && typeof nested === 'string'
      ? [nested]
      : collectJsonReferences(nested),
  );
};

const resolveLocalJsonReference = (root: unknown, reference: string): unknown =>
  reference
    .slice(2)
    .split('/')
    .map((segment) => segment.replaceAll('~1', '/').replaceAll('~0', '~'))
    .reduce<unknown>((current, segment) => {
      if (
        current === null ||
        typeof current !== 'object' ||
        !Object.hasOwn(current, segment)
      ) {
        return undefined;
      }
      return (current as Record<string, unknown>)[segment];
    }, root);

const deeplyFrozenPlainObjects = (value: unknown): boolean => {
  if (
    value === null ||
    typeof value !== 'object' ||
    value instanceof z.ZodType
  ) {
    return true;
  }
  return (
    Object.isFrozen(value) &&
    Object.values(value).every(deeplyFrozenPlainObjects)
  );
};

const registryModule = await import('../src/registry.js').catch(
  () => undefined,
);
const jsonSchemaModule = await import('../scripts/lib/json-schema.js').catch(
  () => undefined,
);
const openApiModule = await import('../scripts/lib/openapi.js').catch(
  () => undefined,
);
const eventsSchemaModule =
  await import('../scripts/lib/events-schema.js').catch(() => undefined);
const typeScriptModule = await import('../scripts/lib/typescript.js').catch(
  () => undefined,
);
const swiftModule = await import('../scripts/lib/swift.js').catch(
  () => undefined,
);
const stableJsonModule = await import('../scripts/lib/stable-json.js').catch(
  () => undefined,
);
const generateModule = await import('../scripts/generate.js').catch(
  () => undefined,
);

type RegistryViewFactory = <Schema extends z.ZodType>(schema: Schema) => Schema;

const registryViewFactory = (
  registryModule as unknown as
    | { createIsolatedSchemaView?: RegistryViewFactory }
    | undefined
)?.createIsolatedSchemaView;

describe('contract registry', () => {
  test('exists before generation begins', () => {
    expect(registryModule).toBeDefined();
    expect(jsonSchemaModule).toBeDefined();
  });

  test('lists every public schema explicitly and excludes factories/helpers', () => {
    if (registryModule === undefined) return;
    const names = Object.keys(registryModule.schemaRegistry);
    expect(names).toEqual(EXPECTED_SCHEMA_NAMES);

    const exportedSchemaNames = Object.entries(publicContracts)
      .filter(
        (entry): entry is [string, z.ZodType] => entry[1] instanceof z.ZodType,
      )
      .map(([name]) => `${name[0]?.toUpperCase()}${name.slice(1, -6)}`)
      .sort(compareText);
    expect(names).toEqual(exportedSchemaNames);
    expect(names).not.toContain('CommandAck');
    expect(names).not.toContain('Page');
    expect(names).not.toContain('StrictObject');
  });

  test('publishes stable, deeply frozen schema/http/event registries', () => {
    if (registryModule === undefined) return;
    const {
      contractRegistry,
      eventSchemaRegistry,
      httpRegistry,
      schemaRegistry,
    } = registryModule;

    expect(Object.keys(schemaRegistry)).toEqual(
      [...Object.keys(schemaRegistry)].sort(compareText),
    );
    expect(Object.keys(httpRegistry)).toEqual(EXPECTED_HTTP_OPERATION_IDS);
    expect(Object.keys(eventSchemaRegistry)).toEqual(
      EXPECTED_EVENT_SCHEMA_NAMES,
    );
    expect(new Set(Object.keys(schemaRegistry)).size).toBe(
      Object.keys(schemaRegistry).length,
    );
    expect(new Set(Object.keys(httpRegistry)).size).toBe(
      Object.keys(httpRegistry).length,
    );
    expect(
      Object.values(schemaRegistry).every(
        (value) => value instanceof z.ZodType,
      ),
    ).toBe(true);
    expect(Object.values(schemaRegistry).every(Object.isFrozen)).toBe(true);
    expect(
      Object.values(httpRegistry).every((value) => Object.isFrozen(value)),
    ).toBe(true);
    expect(
      Object.values(httpRegistry).every((descriptor) =>
        [
          descriptor.pathSchema,
          descriptor.querySchema,
          descriptor.bodySchema,
          descriptor.resultSchema,
        ]
          .filter((value): value is z.ZodType => value instanceof z.ZodType)
          .every(Object.isFrozen),
      ),
    ).toBe(true);
    expect(
      Object.entries(httpRegistry).every(
        ([operationId, descriptor]) => descriptor.operationId === operationId,
      ),
    ).toBe(true);
    expect(Object.isFrozen(contractRegistry)).toBe(true);
    expect(contractRegistry.schemas).toBe(schemaRegistry);
    expect(contractRegistry.http).toBe(httpRegistry);
    expect(contractRegistry.events).toBe(eventSchemaRegistry);
    expect(Object.isFrozen(schemaRegistry)).toBe(true);
    expect(Object.isFrozen(httpRegistry)).toBe(true);
    expect(Object.isFrozen(eventSchemaRegistry)).toBe(true);
    expect(deeplyFrozenPlainObjects(contractRegistry)).toBe(true);
    expect(schemaRegistry.ThreadView).not.toBe(
      publicContracts.threadViewSchema,
    );
    expect(httpRegistry['thread.get']).not.toBe(
      publicContracts.httpContractRegistry['thread.get'],
    );
    expect(Object.isFrozen(publicContracts.threadViewSchema)).toBe(false);
    expect(
      Object.isFrozen(
        publicContracts.httpContractRegistry['thread.get'].resultSchema,
      ),
    ).toBe(false);
    expect(schemaRegistry.ThreadId?.safeParse('thread-1').success).toBe(true);
    expect(publicContracts.threadViewSchema.safeParse({}).success).toBe(false);
  });

  test('matches the authoritative HTTP registry in both directions', () => {
    if (registryModule === undefined) return;
    const generatedKeys = Object.keys(registryModule.httpRegistry);
    const authoritativeKeys = Object.keys(
      publicContracts.httpContractRegistry,
    ).sort(compareText);

    expect(generatedKeys).toEqual(authoritativeKeys);
    expect(authoritativeKeys).toEqual(generatedKeys);
    for (const operationId of authoritativeKeys) {
      expect(registryModule.httpRegistry[operationId]?.operationId).toBe(
        operationId,
      );
    }
  });

  test('identifies the event artifact root and its named envelope dependencies', () => {
    if (registryModule === undefined) return;
    const { eventSchemaRegistry, schemaRegistry } = registryModule;

    expect(eventSchemaRegistry.ThreadStreamFrame).toBe(
      schemaRegistry.ThreadStreamFrame,
    );
    for (const dependency of EXPECTED_EVENT_SCHEMA_NAMES) {
      expect(eventSchemaRegistry[dependency]).toBe(schemaRegistry[dependency]);
    }
    expect(
      eventSchemaRegistry.ThreadStreamFrame?.safeParse('not-a-frame').success,
    ).toBe(false);
  });

  test('stores an immutable non-enumerable JSON snapshot without an authoring-schema escape hatch', () => {
    if (registryModule === undefined) return;
    const view = registryModule.schemaRegistry.HealthResponse;
    if (view === undefined) throw new Error('missing HealthResponse schema');
    expect(Object.getOwnPropertySymbols(view)).toEqual([]);
    expect(Object.keys(view)).not.toContain('jsonSchema');
    expect('getAuthoringSchema' in registryModule).toBe(false);
  });

  test('deeply isolates a view from later nested authoring mutations', () => {
    if (registryModule === undefined || jsonSchemaModule === undefined) return;
    const view = registryModule.schemaRegistry.CreateThreadBody;
    if (view === undefined) throw new Error('missing CreateThreadBody');
    const authoringShape =
      publicContracts.workspaceBindingSchema._zod.def.shape;
    const originalDisplayPath = authoringShape.displayPath;
    const before = JSON.stringify(
      jsonSchemaModule.createJsonSchemaIr({ CreateThreadBody: view }),
    );

    try {
      authoringShape.displayPath = z.number();
      expect(
        view.safeParse({
          commandId: 'command-1',
          workspaceBinding: {
            displayPath: '/workspace',
            trust: 'trusted',
            workspaceId: 'workspace-1',
          },
        }).success,
      ).toBe(true);
      expect(
        JSON.stringify(
          jsonSchemaModule.createJsonSchemaIr({ CreateThreadBody: view }),
        ),
      ).toBe(before);
    } finally {
      authoringShape.displayPath = originalDisplayPath;
    }
  });

  test('isolates custom-prototype string checks from authoring mutations', () => {
    if (registryModule === undefined) return;
    const view = registryModule.schemaRegistry.CanonicalNonBlankString;
    if (view === undefined) throw new Error('missing canonical string schema');
    const minimumCheck =
      publicContracts.canonicalNonBlankStringSchema._zod.def.checks?.find(
        (check) => check._zod.def.check === 'min_length',
      );
    if (minimumCheck === undefined) throw new Error('missing minimum check');
    const mutableDefinition = minimumCheck._zod.def as {
      check: string;
      minimum: number;
    };
    const originalMinimum = mutableDefinition.minimum;

    try {
      mutableDefinition.minimum = 20;
      expect(view.safeParse('valid').success).toBe(true);
      expect(view.safeParse('').success).toBe(false);
    } finally {
      mutableDefinition.minimum = originalMinimum;
    }
  });

  test('deeply freezes isolated schema definitions that can change parsing', () => {
    expect(registryViewFactory).toBeDefined();
    if (registryViewFactory === undefined) return;
    const view = registryViewFactory(
      z.strictObject({
        code: z.string().min(2).regex(/^ok/u),
        kind: z.enum(['one', 'two']),
        values: z.array(z.number().int()),
      }),
    );
    const definition = view._zod.def;
    const shape = definition.shape;
    const code = shape.code;
    const checks = code._zod.def.checks;
    const minimum = checks?.find(
      (check) => check._zod.def.check === 'min_length',
    );
    if (minimum === undefined) throw new Error('missing minimum check');

    expect(
      view.safeParse({ code: 'ok', kind: 'one', values: [1] }).success,
    ).toBe(true);
    expect(Object.isFrozen(view._zod)).toBe(true);
    expect(Object.isFrozen(definition)).toBe(true);
    expect(Object.isFrozen(shape)).toBe(true);
    expect(Object.isFrozen(checks)).toBe(true);
    expect(Object.isFrozen(minimum)).toBe(true);
    expect(Object.isFrozen(minimum._zod)).toBe(true);
    expect(Object.isFrozen(minimum._zod.def)).toBe(true);
    expect(Object.isFrozen(shape.kind._zod.values)).toBe(true);
    expect(Reflect.set(shape, 'code', z.number())).toBe(false);
    expect(Reflect.set(minimum._zod.def, 'minimum', 20)).toBe(false);
    expect(() => shape.kind._zod.values.add('three')).toThrow(/immutable/u);
    expect(() =>
      Set.prototype.add.call(shape.kind._zod.values, 'prototype-bypass'),
    ).toThrow(TypeError);
    expect(
      Reflect.set(
        Object.getPrototypeOf(shape.kind._zod.values),
        'has',
        () => true,
      ),
    ).toBe(false);
    expect(shape.kind.safeParse('prototype-bypass').success).toBe(false);
    expect(
      view.safeParse({ code: 'ok', kind: 'one', values: [1] }).success,
    ).toBe(true);
    expect(
      view.safeParse({ code: 'x', kind: 'one', values: [1] }).success,
    ).toBe(false);
    expect(view.toJSONSchema()).toMatchObject({ type: 'object' });
  });

  test('keeps Map, Set and RegExp-backed validators operational after freezing', () => {
    expect(registryViewFactory).toBeDefined();
    if (registryViewFactory === undefined) return;
    const view = registryViewFactory(
      z.tuple([
        z.map(z.string(), z.number().int()),
        z.set(z.string().regex(/^item-/u)),
      ]),
    );
    const traits = view._zod.traits;

    expect(traits.has('$ZodTuple')).toBe(true);
    expect([...traits]).toContain('$ZodTuple');
    expect(() => Set.prototype.add.call(traits, 'prototype-bypass')).toThrow(
      TypeError,
    );

    expect(
      view.safeParse([
        new Map([['answer', 42]]),
        new Set(['item-one', 'item-two']),
      ]).success,
    ).toBe(true);
    expect(
      view.safeParse([new Map([['answer', 42.5]]), new Set(['invalid'])])
        .success,
    ).toBe(false);
  });

  test('exposes definition Maps through an immutable non-native facade', () => {
    expect(registryViewFactory).toBeDefined();
    if (registryViewFactory === undefined) return;
    const authoring = z.string();
    const nested = { value: 1 };
    Object.assign(authoring._zod.def, {
      lookup: new Map<string, Readonly<{ value: number }>>([
        ['answer', nested],
      ]),
    });
    const view = registryViewFactory(authoring);
    const lookup = (
      view._zod.def as typeof view._zod.def & {
        lookup: ReadonlyMap<string, Readonly<{ value: number }>> & {
          clear(): void;
          delete(key: string): boolean;
          set(key: string, value: Readonly<{ value: number }>): unknown;
        };
      }
    ).lookup;

    expect(lookup instanceof Map).toBe(false);
    expect(lookup.size).toBe(1);
    expect(lookup.has('answer')).toBe(true);
    expect(lookup.get('answer')).toEqual({ value: 1 });
    expect([...lookup]).toEqual([['answer', { value: 1 }]]);
    expect([...lookup.keys()]).toEqual(['answer']);
    expect([...lookup.values()]).toEqual([{ value: 1 }]);
    expect([...lookup.entries()]).toEqual([['answer', { value: 1 }]]);
    const visited: Array<readonly [string, number]> = [];
    lookup.forEach((value, key, collection) => {
      expect(collection).toBe(lookup);
      visited.push([key, value.value]);
    });
    expect(visited).toEqual([['answer', 1]]);
    expect(Object.isFrozen(lookup.get('answer'))).toBe(true);
    expect(() => lookup.set('pwned', { value: 2 })).toThrow(/immutable/u);
    expect(() => lookup.delete('answer')).toThrow(/immutable/u);
    expect(() => lookup.clear()).toThrow(/immutable/u);
    expect(() =>
      Map.prototype.set.call(lookup, 'prototype-bypass', { value: 3 }),
    ).toThrow(TypeError);
    expect(
      Reflect.set(Object.getPrototypeOf(lookup), 'get', () => ({ value: 3 })),
    ).toBe(false);
    expect(view.safeParse('still-valid').success).toBe(true);
  });

  test('captures pre-frozen schemas into a distinct isolated view', () => {
    expect(registryViewFactory).toBeDefined();
    if (registryViewFactory === undefined || jsonSchemaModule === undefined) {
      return;
    }
    const authoring = Object.freeze(z.string().min(2));
    const view = registryViewFactory(authoring);

    expect(view).not.toBe(authoring);
    expect(Object.isFrozen(view)).toBe(true);
    expect(view.safeParse('ok').success).toBe(true);
    expect(
      jsonSchemaModule.createJsonSchemaIr({ Frozen: view }).$defs.Frozen,
    ).toMatchObject({
      type: 'string',
      minLength: 2,
    });
  });

  test('captures a lazy target once while preserving recursive sharing', () => {
    expect(registryViewFactory).toBeDefined();
    if (registryViewFactory === undefined) return;
    let leaf: z.ZodType = z.string();
    const recursive: z.ZodType = z.lazy(() =>
      z.union([leaf, z.array(recursive)]),
    );
    const view = registryViewFactory(recursive);

    leaf = z.number();
    expect(view.safeParse('original').success).toBe(true);
    expect(view.safeParse(['nested', ['value']]).success).toBe(true);
    expect(view.safeParse(42).success).toBe(false);
  });
});

describe('Zod JSON Schema IR', () => {
  test('emits named draft 2020-12 definitions with exact wire semantics', () => {
    if (jsonSchemaModule === undefined) return;
    const fixture = z.strictObject({
      cursor: z.string().regex(/^(0|[1-9]\d*)$/),
      optional: z.string().optional(),
      nullable: z.string().nullable(),
    });

    const ir = jsonSchemaModule.createJsonSchemaIr({ Fixture: fixture });
    const definition = ir.$defs.Fixture;

    expect(ir.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(definition.additionalProperties).toBe(false);
    expect(definition.required).toEqual(['cursor', 'nullable']);
    expect(definition.properties.cursor).toMatchObject({
      type: 'string',
      pattern: '^(0|[1-9]\\d*)$',
    });
    expect(definition.properties.nullable.anyOf).toContainEqual({
      type: 'null',
    });
  });

  test('converts the complete registry into a stably ordered read-only snapshot', () => {
    if (jsonSchemaModule === undefined || registryModule === undefined) return;
    const ir = jsonSchemaModule.createJsonSchemaIr(
      registryModule.schemaRegistry,
    );
    const definitionNames = Object.keys(ir.$defs);

    expect(definitionNames).toEqual([...definitionNames].sort(compareText));
    expect(EXPECTED_SCHEMA_NAMES.every((name) => name in ir.$defs)).toBe(true);
    expect(ir.$defs.TokenRef.description).toContain(
      'OS credential-store reference',
    );
    expect(ir.$defs.UndefinedResult).toEqual({ not: {} });
    expect(Object.isFrozen(ir)).toBe(true);
    expect(Object.isFrozen(ir.$defs)).toBe(true);
  });

  test('never observes later mutations to an original authoring schema', () => {
    if (jsonSchemaModule === undefined || registryModule === undefined) return;
    const view = registryModule.schemaRegistry.HealthResponse;
    if (view === undefined) throw new Error('missing HealthResponse schema');
    const originalInternals =
      publicContracts.healthResponseSchema as unknown as {
        _zod: { def: unknown };
      };
    const replacementInternals = z.string() as unknown as {
      _zod: { def: unknown };
    };
    const originalDefinition = originalInternals._zod.def;
    const before = JSON.stringify(
      jsonSchemaModule.createJsonSchemaIr({ HealthResponse: view }),
    );

    try {
      originalInternals._zod.def = replacementInternals._zod.def;
      const after = JSON.stringify(
        jsonSchemaModule.createJsonSchemaIr({ HealthResponse: view }),
      );
      expect(after).toBe(before);
    } finally {
      originalInternals._zod.def = originalDefinition;
    }
  });

  test('does not trust reflected metadata copied onto an external schema', () => {
    if (jsonSchemaModule === undefined || registryModule === undefined) return;
    const registryView = registryModule.schemaRegistry.HealthResponse;
    if (registryView === undefined) throw new Error('missing HealthResponse');
    const external = z.string();
    for (const symbol of Object.getOwnPropertySymbols(registryView)) {
      const descriptor = Object.getOwnPropertyDescriptor(registryView, symbol);
      if (descriptor !== undefined) {
        Object.defineProperty(external, symbol, descriptor);
      }
    }

    expect(
      jsonSchemaModule.createJsonSchemaIr({ External: external }).$defs
        .External,
    ).toMatchObject({ type: 'string' });
  });

  test('preserves __proto__ as schema data in properties and top-level definitions', () => {
    if (jsonSchemaModule === undefined) return;
    const definitions = Object.fromEntries([
      ['Container', z.strictObject({ ['__proto__']: z.string() })],
      ['__proto__', z.string()],
    ]);
    const ir = jsonSchemaModule.createJsonSchemaIr(definitions);
    const container = ir.$defs.Container;
    const properties = container.properties as Record<string, unknown>;

    expect(Object.hasOwn(ir.$defs, '__proto__')).toBe(true);
    expect(ir.$defs.__proto__).toMatchObject({ type: 'string' });
    expect(Object.hasOwn(properties, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(properties)).toBeNull();
    expect(Object.getPrototypeOf(ir.$defs)).toBeNull();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  test('preserves __proto__ inside nested object shapes', () => {
    if (jsonSchemaModule === undefined) return;
    const ir = jsonSchemaModule.createJsonSchemaIr({
      Nested: z.strictObject({
        child: z.strictObject({ ['__proto__']: z.string() }),
      }),
    });
    const rootProperties = ir.$defs.Nested.properties as Record<
      string,
      Record<string, unknown>
    >;
    const childProperties = rootProperties.child?.properties as Record<
      string,
      unknown
    >;

    expect(Object.hasOwn(childProperties, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(childProperties)).toBeNull();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  test('preserves __proto__ through nullable object output', () => {
    if (jsonSchemaModule === undefined) return;
    const ir = jsonSchemaModule.createJsonSchemaIr({
      Nullable: z.strictObject({
        child: z.strictObject({ ['__proto__']: z.string() }).nullable(),
      }),
    });
    const rootProperties = ir.$defs.Nullable.properties as Record<
      string,
      Record<string, unknown>
    >;
    const branches = rootProperties.child?.anyOf as Record<string, unknown>[];
    const objectBranch = branches.find((branch) => branch.type === 'object');
    const properties = objectBranch?.properties as Record<string, unknown>;

    expect(Object.hasOwn(properties, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(properties)).toBeNull();
  });

  test('preserves recursive lazy __proto__ properties and scoped refs', () => {
    if (jsonSchemaModule === undefined) return;
    const recursive: z.ZodType = z.lazy(() =>
      z.strictObject({
        ['__proto__']: z.string(),
        next: recursive.optional(),
      }),
    );
    const ir = jsonSchemaModule.createJsonSchemaIr({ Recursive: recursive });
    const serialized = JSON.stringify(ir);
    const references = [
      ...serialized.matchAll(/"\$ref":"#\/\$defs\/([^"]+)"/g),
    ].map((match) => match[1]);
    const recursiveObject = Object.values(ir.$defs).find(
      (definition) =>
        definition.type === 'object' &&
        Object.hasOwn(
          definition.properties as Record<string, unknown>,
          '__proto__',
        ),
    );

    expect(recursiveObject).toBeDefined();
    expect(references.length).toBeGreaterThan(0);
    expect(
      references.every((target) => target !== undefined && target in ir.$defs),
    ).toBe(true);
    expect(serialized).not.toContain('"$ref":"#"');
  });

  test('escapes recursive top-level definition names as JSON Pointer segments', () => {
    if (jsonSchemaModule === undefined) return;
    const slashRecursive: z.ZodType = z.lazy(() =>
      z.strictObject({ next: slashRecursive.optional() }),
    );
    const tildeRecursive: z.ZodType = z.lazy(() =>
      z.strictObject({ next: tildeRecursive.optional() }),
    );
    const ir = jsonSchemaModule.createJsonSchemaIr({
      'A/B': slashRecursive,
      'A~B': tildeRecursive,
    });
    const slashDefinition = ir.$defs['A/B'];
    const tildeDefinition = ir.$defs['A~B'];

    expect(slashDefinition).toBeDefined();
    expect(tildeDefinition).toBeDefined();
    expect(JSON.stringify(slashDefinition)).toContain('"$ref":"#/$defs/A~1B"');
    expect(JSON.stringify(tildeDefinition)).toContain('"$ref":"#/$defs/A~0B"');
  });

  test('fails closed when a real shape key collides with the reserved proto placeholder', () => {
    if (jsonSchemaModule === undefined) return;
    const reserved = '\u0000colorful-code:__proto__';
    expect(() =>
      jsonSchemaModule.createJsonSchemaIr({
        Collision: z.strictObject({
          ['__proto__']: z.string(),
          [reserved]: z.string(),
        }),
      }),
    ).toThrow('reserved proto placeholder');
  });

  test('allows a structural pipe only when its output is a complete wire schema', () => {
    if (jsonSchemaModule === undefined) return;
    const ir = jsonSchemaModule.createJsonSchemaIr({
      SafePipe: z.string().pipe(z.string().min(1)),
    });

    expect(ir.$defs.SafePipe).toMatchObject({ type: 'string', minLength: 1 });
  });

  test('preserves typed refine and preprocess output wire structures', () => {
    if (jsonSchemaModule === undefined) return;
    const ir = jsonSchemaModule.createJsonSchemaIr({
      NumberRefine: z.number().refine(Number.isFinite),
      ObjectRefine: z.object({ flag: z.boolean() }).refine(Boolean),
      Preprocess: z.preprocess(
        (value) => value,
        z.strictObject({ value: z.string() }),
      ),
      StringRefine: z.string().refine(Boolean),
    });

    expect(ir.$defs.StringRefine).toMatchObject({ type: 'string' });
    expect(ir.$defs.NumberRefine).toMatchObject({ type: 'number' });
    expect(ir.$defs.ObjectRefine).toMatchObject({
      type: 'object',
      additionalProperties: false,
    });
    expect(ir.$defs.Preprocess).toMatchObject({
      type: 'object',
      additionalProperties: false,
    });
  });

  test('rejects a generated nested definition that collides with a top-level name', () => {
    if (jsonSchemaModule === undefined) return;
    expect(() =>
      jsonSchemaModule.createJsonSchemaIr({
        Recursive: publicContracts.jsonValueSchema,
        Recursive____schema0: z.string(),
      }),
    ).toThrow(
      'Recursive nested definition __schema0 collides with top-level schema Recursive____schema0',
    );
  });

  test.each([
    [
      'Transform',
      z.strictObject({ value: z.string().transform((value) => value) }),
      '$.value',
    ],
    ['Function', z.strictObject({ value: z.function() }), '$.value'],
    ['Symbol', z.strictObject({ value: z.symbol() }), '$.value'],
    ['BigInt', z.strictObject({ value: z.bigint() }), '$.value'],
    [
      'CustomRefine',
      z.strictObject({ value: z.unknown().refine(Boolean) }),
      '$.value',
    ],
    [
      'WidePreprocess',
      z.strictObject({ value: z.preprocess((value) => value, z.unknown()) }),
      '$.value',
    ],
  ] as const)(
    'rejects unsupported %s nodes with schema name and path',
    (name, schema, path) => {
      if (jsonSchemaModule === undefined) return;
      expect(() =>
        jsonSchemaModule.createJsonSchemaIr({ [name]: schema }),
      ).toThrow(`${name} at ${path}`);
    },
  );
});

describe('OpenAPI 3.1 emitter', () => {
  test('emits stable registry-backed operations and reusable error responses', () => {
    expect(openApiModule).toBeDefined();
    if (openApiModule === undefined) return;

    const document = openApiModule.createOpenApiDocument();
    const paths = document.paths as Record<
      string,
      Record<string, Record<string, unknown>>
    >;
    const serialized = JSON.stringify(document);

    expect(document.openapi).toBe('3.1.0');
    expect(document.info).toEqual({
      title: 'Colorful Code API',
      version: '0.0.0',
    });
    expect(document.servers).toEqual([]);
    expect(Object.keys(paths)).toEqual(
      [...Object.keys(paths)].sort(compareText),
    );
    expect(
      Object.values(paths)
        .flatMap((pathItem) => Object.values(pathItem))
        .map((operation) => operation.operationId)
        .sort(compareText),
    ).toEqual([...EXPECTED_HTTP_OPERATION_IDS]);
    expect(Object.keys(document.components.schemas)).toEqual(
      [...Object.keys(document.components.schemas)].sort(compareText),
    );

    const threadGet = paths['/v2/threads/{threadId}']?.get;
    const threadCreate = paths['/v2/threads']?.post;
    const threadList = paths['/v2/threads']?.get;
    expect(threadGet?.parameters).toContainEqual({
      in: 'path',
      name: 'threadId',
      required: true,
      schema: {
        $ref: '#/components/schemas/ThreadPath/properties/threadId',
      },
    });
    expect(threadList?.parameters).toContainEqual({
      in: 'query',
      name: 'limit',
      required: false,
      schema: {
        $ref: '#/components/schemas/PaginationQuery/properties/limit',
      },
    });
    expect(threadCreate?.requestBody).toEqual({
      required: true,
      content: {
        'application/json': {
          schema: { $ref: '#/components/schemas/CreateThreadBody' },
        },
      },
    });
    expect(threadList?.requestBody).toBeUndefined();
    expect(threadGet?.responses).toMatchObject({
      '200': {
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/ThreadView' },
          },
        },
      },
    });
    expect(threadCreate?.responses).toMatchObject({
      '202': {
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/ThreadCreateResponse' },
          },
        },
      },
      '400': { $ref: '#/components/responses/ApiError400' },
      '503': { $ref: '#/components/responses/ApiError503' },
    });
    expect(document.components.responses.ApiError400).toMatchObject({
      content: {
        'application/json': {
          schema: { $ref: '#/components/schemas/ApiError' },
        },
      },
    });
    expect(serialized).not.toMatch(/handler|controller|serverImplementation/i);
    expect(Object.isFrozen(document)).toBe(true);
  });

  test('rewrites every named IR reference into a resolvable OpenAPI component reference', () => {
    expect(openApiModule).toBeDefined();
    if (openApiModule === undefined) return;

    const document = openApiModule.createOpenApiDocument();
    const references = collectJsonReferences(document);
    const localReferences = references.filter((reference) =>
      reference.startsWith('#/'),
    );

    expect(
      references.some((reference) => reference.startsWith('#/$defs/')),
    ).toBe(false);
    expect(localReferences.length).toBeGreaterThan(0);
    expect(
      localReferences.every(
        (reference) =>
          resolveLocalJsonReference(document, reference) !== undefined,
      ),
    ).toBe(true);
  });

  test('extracts union-object query parameters and selects the role-specific schema alias', () => {
    expect(openApiModule).toBeDefined();
    if (openApiModule === undefined) return;

    const document = openApiModule.createOpenApiDocument();
    const operation = (
      document.paths['/v2/threads/{threadId}/events'] as Record<
        string,
        Record<string, unknown>
      >
    ).get;
    const queryParameters = (
      operation?.parameters as Array<Record<string, unknown>>
    ).filter((parameter) => parameter.in === 'query');

    expect(queryParameters.map((parameter) => parameter.name)).toEqual([
      'durableAfter',
      'incarnationId',
      'streamAfter',
    ]);
    expect(
      queryParameters.every((parameter) => parameter.required === false),
    ).toBe(true);
    expect(queryParameters.map((parameter) => parameter.schema)).toEqual([
      {
        $ref: '#/components/schemas/EventAttachQuery/anyOf/0/properties/durableAfter',
      },
      {
        $ref: '#/components/schemas/EventAttachQuery/anyOf/1/properties/incarnationId',
      },
      {
        $ref: '#/components/schemas/EventAttachQuery/anyOf/1/properties/streamAfter',
      },
    ]);
    expect(operation?.['x-colorful-code-query-schema']).toEqual({
      $ref: '#/components/schemas/EventAttachQuery',
    });
    const eventAttachQuery = document.components.schemas.EventAttachQuery as {
      anyOf: Array<Record<string, unknown>>;
    };
    expect(eventAttachQuery.anyOf).toHaveLength(2);
    expect(eventAttachQuery.anyOf[1]?.required).toEqual([
      'incarnationId',
      'streamAfter',
    ]);
  });

  test('resolves local refs and merges allOf object intersections into parameters', () => {
    expect(openApiModule).toBeDefined();
    expect(registryModule).toBeDefined();
    if (openApiModule === undefined || registryModule === undefined) return;

    const recursive: z.ZodType = z.lazy(() =>
      z.strictObject({ a: z.string(), next: recursive.optional() }),
    );
    const query = registryModule.createIsolatedSchemaView(
      z.intersection(recursive, z.strictObject({ b: z.number() })),
    );
    const response = registryModule.createIsolatedSchemaView(
      z.strictObject({ ok: z.literal(true) }),
    );
    const registry = {
      schemas: { IntersectionQuery: query, IntersectionResponse: response },
      http: {
        'fixture.get': {
          method: 'GET',
          path: '/fixture',
          operationId: 'fixture.get',
          querySchema: query,
          resultSchema: response,
          responseKind: 'query',
        },
      },
      events: {},
    } as unknown as Parameters<typeof openApiModule.createOpenApiDocument>[0];

    const document = openApiModule.createOpenApiDocument(registry);
    const operation = document.paths['/fixture']?.get as Record<
      string,
      unknown
    >;
    const parameters = operation.parameters as Array<Record<string, unknown>>;

    expect(parameters.map(({ name, required }) => [name, required])).toEqual([
      ['a', true],
      ['b', true],
      ['next', false],
    ]);
    expect(operation['x-colorful-code-query-schema']).toEqual({
      $ref: '#/components/schemas/FixtureGetQuery',
    });
  });

  test('preserves compatible same-name allOf property constraints as referenced conjunctions', () => {
    expect(openApiModule).toBeDefined();
    if (openApiModule === undefined) return;

    const query = z.intersection(
      z.strictObject({ a: z.string().min(1) }),
      z.strictObject({ a: z.string().max(3) }),
    );
    const response = z.strictObject({ ok: z.literal(true) });
    const registry = {
      schemas: {},
      http: {
        'constraint.get': {
          method: 'GET',
          path: '/constraint',
          operationId: 'constraint.get',
          querySchema: query,
          resultSchema: response,
          responseKind: 'query',
        },
      },
      events: {},
    } as unknown as Parameters<typeof openApiModule.createOpenApiDocument>[0];

    const document = openApiModule.createOpenApiDocument(registry);
    const operation = document.paths['/constraint']?.get as Record<
      string,
      unknown
    >;
    const parameters = operation.parameters as Array<Record<string, unknown>>;

    expect(parameters).toContainEqual({
      in: 'query',
      name: 'a',
      required: true,
      schema: {
        allOf: [
          {
            $ref: '#/components/schemas/ConstraintGetQuery/allOf/0/properties/a',
          },
          {
            $ref: '#/components/schemas/ConstraintGetQuery/allOf/1/properties/a',
          },
        ],
      },
    });
  });

  test('rejects duplicate operation ids and duplicate normalized routes before generation', () => {
    expect(openApiModule).toBeDefined();
    expect(registryModule).toBeDefined();
    if (openApiModule === undefined || registryModule === undefined) return;

    const threadGet = registryModule.httpRegistry['thread.get'];
    const threadList = registryModule.httpRegistry['thread.list'];
    const duplicateOperationRegistry = {
      ...registryModule.contractRegistry,
      http: {
        first: threadGet,
        second: { ...threadList, operationId: threadGet.operationId },
      },
    } as unknown as Parameters<typeof openApiModule.createOpenApiDocument>[0];
    expect(() =>
      openApiModule.createOpenApiDocument(duplicateOperationRegistry),
    ).toThrow(/duplicate operationId.*thread\.get.*first.*second/i);

    const duplicateRouteRegistry = {
      ...registryModule.contractRegistry,
      http: {
        first: threadGet,
        second: {
          ...threadList,
          operationId: 'fixture.second',
          path: threadGet.path,
          method: threadGet.method.toLowerCase(),
        },
      },
    } as unknown as Parameters<typeof openApiModule.createOpenApiDocument>[0];
    expect(() =>
      openApiModule.createOpenApiDocument(duplicateRouteRegistry),
    ).toThrow(/duplicate route.*thread\.get.*fixture\.second/i);
  });

  test('keeps generated maps safe for prototype-like keys', () => {
    expect(openApiModule).toBeDefined();
    if (openApiModule === undefined) return;

    const document = openApiModule.createOpenApiDocument();
    expect(Object.getPrototypeOf(document.paths)).toBeNull();
    expect(Object.getPrototypeOf(document.components.schemas)).toBeNull();
    expect(Object.getPrototypeOf(document.components.responses)).toBeNull();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('thread stream events schema emitter', () => {
  test('emits a frozen draft 2020-12 root and its complete named dependency set', () => {
    expect(eventsSchemaModule).toBeDefined();
    if (eventsSchemaModule === undefined) return;

    const document = eventsSchemaModule.createEventsSchema();
    const serialized = JSON.stringify(document);
    const durableEnvelope = document.$defs.KnownDurableEventEnvelope as Record<
      string,
      unknown
    >;

    expect(document.$schema).toBe(
      'https://json-schema.org/draft/2020-12/schema',
    );
    expect(document.title).toBe('Colorful Code Thread Stream Events');
    expect(document.version).toBe('0.0.0');
    expect(document.$ref).toBe('#/$defs/ThreadStreamFrame');
    expect(
      EXPECTED_EVENT_SCHEMA_NAMES.every((name) => name in document.$defs),
    ).toBe(true);
    expect(document.$defs.ApiError).toBeUndefined();
    expect(document.$defs.CreateThreadBody).toBeUndefined();
    expect(serialized).toContain('"const":"durable"');
    expect(serialized).toContain('"const":"transient"');
    expect(serialized).toContain('"kind"');
    expect(serialized).toContain('"pattern":"^(0|[1-9]\\\\d*)$"');
    expect(serialized).toContain('"additionalProperties":false');
    expect(durableEnvelope).toBeDefined();
    expect(Object.keys(document.$defs)).toEqual(
      [...Object.keys(document.$defs)].sort(compareText),
    );
    expect(Object.getPrototypeOf(document.$defs)).toBeNull();
    expect(Object.isFrozen(document)).toBe(true);
    expect(Object.isFrozen(document.$defs)).toBe(true);
  });
});

describe('TypeScript contracts emitter', () => {
  test('re-exports authoring validators and infers types in registry-key order', () => {
    expect(typeScriptModule).toBeDefined();
    expect(registryModule).toBeDefined();
    if (typeScriptModule === undefined || registryModule === undefined) return;

    const source = typeScriptModule.createTypeScriptContracts(
      registryModule.schemaRegistry,
    );
    const health = source.indexOf('healthResponseSchema');
    const thread = source.indexOf('threadViewSchema');

    expect(source).toStartWith(
      "// This file is generated. Do not edit.\n\nimport { z } from 'zod';\n",
    );
    expect(source).toContain(
      "import { healthResponseSchema } from '../../src/common.js';",
    );
    expect(source).toContain(
      "export { threadViewSchema } from '../../src/thread.js';",
    );
    expect(source).toContain(
      'export type ThreadView = z.infer<typeof threadViewSchema>;',
    );
    expect(source).not.toContain("from '../../src/index.js'");
    expect(source).not.toMatch(/\b(?:interface|namespace)\b/);
    expect(health).toBeLessThan(thread);
    expect(source.endsWith('\n')).toBe(true);
  });

  test('fails closed when the registry contains an unmapped schema name', () => {
    expect(typeScriptModule).toBeDefined();
    if (typeScriptModule === undefined) return;

    expect(() =>
      typeScriptModule.createTypeScriptContracts({ Mystery: z.string() }),
    ).toThrow(/unmapped registry schema.*Mystery/i);
  });
});

describe('Swift contracts emitter', () => {
  const fixtureIr = {
    $schema: 'https://json-schema.org/draft/2020-12/schema' as const,
    $defs: {
      Choice: {
        oneOf: [
          {
            type: 'object',
            properties: {
              kind: { type: 'string', const: 'known' },
              value: { type: 'string' },
            },
            required: ['kind', 'value'],
            additionalProperties: false,
          },
          {
            type: 'object',
            properties: {
              kind: { type: 'string', pattern: '^(?!known$).+' },
              durability: { type: 'string', const: 'durable' },
              critical: { type: 'boolean' },
              payload: { $ref: '#/$defs/JsonValue' },
            },
            required: ['kind', 'durability', 'critical', 'payload'],
            additionalProperties: false,
          },
          {
            type: 'object',
            properties: {
              kind: { type: 'string', pattern: '^(?!known$).+' },
              durability: { type: 'string', const: 'transient' },
              critical: { type: 'boolean' },
              payload: { $ref: '#/$defs/JsonValue' },
            },
            required: ['kind', 'durability', 'critical', 'payload'],
            additionalProperties: false,
          },
        ],
      },
      Fixture: {
        type: 'object',
        properties: {
          class: { type: 'boolean' },
          cursor: { type: 'string', pattern: '^(0|[1-9]\\d*)$' },
          generation: { type: 'integer', minimum: 0 },
          inlineMode: { type: 'string', enum: ['one', 'two'] },
          nullable: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          nothing: { type: 'null' },
          optional: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
          'wire-name': { type: 'string' },
        },
        required: [
          'class',
          'cursor',
          'generation',
          'inlineMode',
          'nullable',
          'nothing',
          'tags',
          'wire-name',
        ],
        additionalProperties: false,
      },
      JsonValue: {
        anyOf: [
          { type: 'string' },
          { type: 'number' },
          { type: 'boolean' },
          { type: 'null' },
          { type: 'array', items: { $ref: '#/$defs/JsonValue' } },
          {
            type: 'object',
            additionalProperties: { $ref: '#/$defs/JsonValue' },
          },
        ],
      },
      Mode: { type: 'string', enum: ['fast-mode', 'slow', 'switch'] },
    },
  };

  test('maps enums, strict structs, presence, identifiers, arrays and unions deterministically', () => {
    expect(swiftModule).toBeDefined();
    if (swiftModule === undefined) return;

    const source = swiftModule.createSwiftContracts(fixtureIr);
    const sourceAgain = swiftModule.createSwiftContracts({
      ...fixtureIr,
      $defs: Object.fromEntries(Object.entries(fixtureIr.$defs).reverse()),
    });

    expect(source).toStartWith(
      '// This file is generated. Do not edit.\n\nimport Foundation\n',
    );
    expect(source).toContain(
      'public indirect enum JSONValue: Codable, Sendable',
    );
    expect(source).toContain('struct AnyCodingKey: CodingKey');
    expect(source).toContain('throw DecodingError.dataCorrupted');
    expect(source).toContain('decodeJSONValue(ChoiceKnown.self, from: raw)');
    expect(source).toContain('case unknownEvent(ChoiceUnknownEvent)');
    expect(source).toContain('case unknownEvent3(ChoiceUnknownEvent3)');
    expect(source).toContain(
      'decodeJSONValue(ChoiceUnknownEvent.self, from: raw)',
    );
    expect(source).toContain(
      'decodeJSONValue(ChoiceUnknownEvent3.self, from: raw)',
    );
    expect(source).toContain('self.durability == "durable"');
    expect(source).toContain('self.durability == "transient"');
    expect(source).toContain('public enum Presence<Value: Codable & Sendable>');
    expect(source).toContain('public enum Mode: String, Codable, Sendable');
    expect(source).toContain('case fastMode = "fast-mode"');
    expect(source).toContain('case `switch` = "switch"');
    expect(source).toContain('public let `class`: Bool');
    expect(source).toContain('public let cursor: String');
    expect(source).toContain('public let generation: Int');
    expect(source).toContain('public let inlineMode: FixtureInlineMode');
    expect(source).toContain(
      'public enum FixtureInlineMode: String, Codable, Sendable',
    );
    expect(source).toContain('public let nullable: Presence<String>');
    expect(source).toContain('public let nothing: JSONNull');
    expect(source).toContain('public let optional: String?');
    expect(source).toContain('public let tags: [String]');
    expect(source).toContain('case wireName = "wire-name"');
    expect(source).toMatch(
      /public enum Choice: Codable, Sendable[\s\S]*case known\([^)]+\)[\s\S]*case unknownEvent\([^)]+\)/,
    );
    expect(source.indexOf('case `class`')).toBeLessThan(
      source.indexOf('case cursor'),
    );
    expect(sourceAgain).toBe(source);
  });

  test('executes strict optional, null, inline-enum and unknown-event decoding', () => {
    expect(swiftModule).toBeDefined();
    if (swiftModule === undefined) return;

    const contracts = swiftModule.createSwiftContracts(fixtureIr);
    const checks = String.raw`
@main
struct RuntimeChecks {
  static func data(_ source: String) -> Data { Data(source.utf8) }

  static func main() throws {
    let decoder = JSONDecoder()
    let missingOptional = #"{"class":true,"cursor":"0","generation":0,"inlineMode":"one","nullable":null,"nothing":null,"tags":[],"wire-name":"ok"}"#
    guard (try? decoder.decode(Fixture.self, from: data(missingOptional))) != nil else { fatalError("missing optional must decode") }

    let nullOptional = #"{"class":true,"cursor":"0","generation":0,"inlineMode":"one","nullable":null,"nothing":null,"optional":null,"tags":[],"wire-name":"ok"}"#
    guard (try? decoder.decode(Fixture.self, from: data(nullOptional))) == nil else { fatalError("present null optional must fail") }

    guard (try? decoder.decode(JSONNull.self, from: data("null"))) != nil else { fatalError("JSONNull must decode null") }
    guard (try? decoder.decode(JSONNull.self, from: data("0"))) == nil else { fatalError("JSONNull must reject values") }

    let invalidEnum = #"{"class":true,"cursor":"0","generation":0,"inlineMode":"invalid","nullable":null,"nothing":null,"tags":[],"wire-name":"ok"}"#
    guard (try? decoder.decode(Fixture.self, from: data(invalidEnum))) == nil else { fatalError("inline enum must reject invalid raw values") }

    let validUnknown = #"{"kind":"other","durability":"durable","critical":false,"payload":null}"#
    guard (try? decoder.decode(Choice.self, from: data(validUnknown))) != nil else { fatalError("valid unknown event must decode") }
    let blankUnknown = #"{"kind":"","durability":"durable","critical":false,"payload":null}"#
    guard (try? decoder.decode(Choice.self, from: data(blankUnknown))) == nil else { fatalError("unknown event pattern must reject blank kind") }
  }
}
`;

    const swiftVersion = Bun.spawnSync(['swiftc', '--version']);
    if (swiftVersion.exitCode !== 0) return;
    const directory = mkdtempSync(join(tmpdir(), 'colorful-schema-runtime-'));
    try {
      const input = join(directory, 'Runtime.swift');
      const executable = join(directory, 'RuntimeChecks');
      writeFileSync(input, `${contracts}\n${checks}`);
      const compile = Bun.spawnSync(
        [
          'swiftc',
          '-parse-as-library',
          '-module-cache-path',
          directory,
          input,
          '-o',
          executable,
        ],
        { stdout: 'pipe', stderr: 'pipe' },
      );
      expect(new TextDecoder().decode(compile.stderr)).toBe('');
      expect(compile.exitCode).toBe(0);
      const run = Bun.spawnSync([executable], {
        stdout: 'pipe',
        stderr: 'pipe',
      });
      expect(new TextDecoder().decode(run.stderr)).toBe('');
      expect(run.exitCode).toBe(0);
    } finally {
      rmSync(directory, { recursive: true });
    }
  }, 60_000);

  test('does not treat an arbitrary patterned discriminator as an unknown event fallback', () => {
    expect(swiftModule).toBeDefined();
    if (swiftModule === undefined) return;

    const source = swiftModule.createSwiftContracts({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $defs: {
        PatternChoice: {
          oneOf: [
            {
              type: 'object',
              properties: {
                kind: { type: 'string', const: 'known' },
              },
              required: ['kind'],
              additionalProperties: false,
            },
            {
              type: 'object',
              properties: {
                kind: { type: 'string', pattern: '^(?!known$).+' },
              },
              required: ['kind'],
              additionalProperties: false,
            },
          ],
        },
      },
    });

    expect(source).not.toContain('case unknownEvent');
    expect(source).toContain('default: throw DecodingError.dataCorrupted');
  });

  test('fails closed on normalized enum-case and object-member collisions', () => {
    expect(swiftModule).toBeDefined();
    if (swiftModule === undefined) return;

    expect(() =>
      swiftModule.createSwiftContracts({
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        $defs: {
          Collision: { type: 'string', enum: ['fast-mode', 'fast_mode'] },
        },
      }),
    ).toThrow(/enum case collision.*fast-mode.*fast_mode/i);

    expect(() =>
      swiftModule.createSwiftContracts({
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        $defs: {
          Collision: {
            type: 'object',
            properties: {
              'wire-name': { type: 'string' },
              wire_name: { type: 'string' },
            },
            additionalProperties: false,
          },
        },
      }),
    ).toThrow(/member collision.*wire-name.*wire_name/i);
  });

  test('emits the complete registry as source accepted by swiftc', () => {
    expect(swiftModule).toBeDefined();
    expect(jsonSchemaModule).toBeDefined();
    expect(registryModule).toBeDefined();
    if (
      swiftModule === undefined ||
      jsonSchemaModule === undefined ||
      registryModule === undefined
    ) {
      return;
    }

    const source = swiftModule.createSwiftContracts(
      jsonSchemaModule.createJsonSchemaIr(registryModule.schemaRegistry),
    );
    expect(source).toContain('public struct ThreadView');
    expect(source).toContain('public enum ThreadStreamFrame');
    expect(source).toContain('case unknownEvent');
    expect(source).toMatch(
      /public enum UnknownEventEnvelope: Codable, Sendable[\s\S]*case unknownEvent\(UnknownEventEnvelopeUnknownEvent\)[\s\S]*case unknownEvent2\(UnknownEventEnvelopeUnknownEvent2\)/,
    );
    expect(source).toContain(
      'decodeJSONValue(UnknownEventEnvelopeUnknownEvent.self, from: raw)',
    );
    expect(source).toContain(
      'decodeJSONValue(UnknownEventEnvelopeUnknownEvent2.self, from: raw)',
    );

    const swiftVersion = Bun.spawnSync(['swiftc', '--version']);
    if (swiftVersion.exitCode !== 0) return;
    const directory = mkdtempSync(join(tmpdir(), 'colorful-schema-swift-'));
    try {
      const input = join(directory, 'Contracts.swift');
      writeFileSync(input, source);
      const result = Bun.spawnSync(
        ['swiftc', '-module-cache-path', directory, '-typecheck', input],
        {
          stdout: 'pipe',
          stderr: 'pipe',
        },
      );
      expect(new TextDecoder().decode(result.stderr)).toBe('');
      expect(result.exitCode).toBe(0);
    } finally {
      rmSync(directory, { recursive: true });
    }
  }, 60_000);
});

const GENERATED_PATHS = [
  'generated/openapi.v2.json',
  'generated/events.schema.json',
  'generated/typescript/contracts.ts',
  'swift-fixture/Sources/ColorfulCodeContracts/ColorfulCodeContracts.swift',
] as const;

const digestFiles = (root: string) =>
  GENERATED_PATHS.map((path) => {
    const bytes = readFileSync(join(root, path));
    return [
      path,
      createHash('sha256').update(bytes).digest('hex'),
      bytes,
    ] as const;
  });

const generationResidue = (root: string) =>
  readdirSync(root).filter((name) => name.startsWith('.schema-generation.'));

describe('stable JSON serialization', () => {
  test('sorts object keys by Unicode code point while preserving arrays and one LF', () => {
    expect(stableJsonModule).toBeDefined();
    if (stableJsonModule === undefined) return;
    const value = Object.fromEntries([
      ['z', 1],
      ['\u{10000}', 2],
      ['\ue000', 3],
      ['array', [{ b: 2, a: 1 }, 'z', 'a']],
    ]);
    expect(stableJsonModule.stableJson(value)).toBe(
      '{\n  "array": [\n    {\n      "a": 1,\n      "b": 2\n    },\n    "z",\n    "a"\n  ],\n  "z": 1,\n  "\ue000": 3,\n  "𐀀": 2\n}\n',
    );
  });

  test('rejects values that JSON would silently widen or erase', () => {
    expect(stableJsonModule).toBeDefined();
    if (stableJsonModule === undefined) return;
    for (const value of [NaN, Infinity, undefined, 1n]) {
      expect(() => stableJsonModule.stableJson(value)).toThrow();
    }
    expect(() => stableJsonModule.stableJson({ value: undefined })).toThrow();
    expect(() => stableJsonModule.stableJson(new Date())).toThrow(/plain/i);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => stableJsonModule.stableJson(cyclic)).toThrow(/cycle/i);
    const sparse = Array(2);
    sparse[1] = 'present';
    expect(() => stableJsonModule.stableJson(sparse)).toThrow(/sparse/i);
  });

  test('preserves __proto__ as inert data without prototype pollution', () => {
    expect(stableJsonModule).toBeDefined();
    if (stableJsonModule === undefined) return;
    const value = Object.fromEntries([['__proto__', { polluted: true }]]);
    expect(stableJsonModule.stableJson(value)).toContain('"__proto__"');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('atomic deterministic generation', () => {
  test('generates identical bytes and SHA-256 digests twice in two package roots', async () => {
    expect(generateModule).toBeDefined();
    if (generateModule === undefined) return;
    const roots = [
      mkdtempSync(join(tmpdir(), 'colorful-generate-a-')),
      mkdtempSync(join(tmpdir(), 'colorful-generate-b-')),
    ];
    try {
      const observations = [];
      for (const packageRoot of roots) {
        await generateModule.generateContracts({ packageRoot });
        const first = digestFiles(packageRoot);
        await generateModule.generateContracts({ packageRoot });
        const second = digestFiles(packageRoot);
        expect(second).toEqual(first);
        observations.push(second);
      }
      expect(observations[1]).toEqual(observations[0]);
    } finally {
      for (const root of roots) rmSync(root, { recursive: true });
    }
  }, 60_000);

  test('serializes two generator processes without interleaving output', async () => {
    expect(generateModule).toBeDefined();
    if (generateModule === undefined) return;
    const root = mkdtempSync(join(tmpdir(), 'colorful-generate-processes-'));
    const runner = join(root, 'runner.ts');
    const held = join(root, 'held.marker');
    const release = join(root, 'release.marker');
    const waited = join(root, 'waited.marker');
    const moduleUrl = new URL('../scripts/generate.ts', import.meta.url).href;
    writeFileSync(
      runner,
      `import { existsSync, writeFileSync } from 'node:fs'; import { generateContracts } from ${JSON.stringify(moduleUrl)};
const [root, role] = process.argv.slice(2);
await generateContracts({ packageRoot: root, dependencies: role === 'first' ? { afterLockAcquired: async () => { writeFileSync(${JSON.stringify(held)}, 'held'); while (!existsSync(${JSON.stringify(release)})) await Bun.sleep(10); } } : { onLockCollision: () => writeFileSync(${JSON.stringify(waited)}, 'waited') } });`,
    );
    try {
      const first = Bun.spawn(['bun', runner, root, 'first'], {
        stdout: 'pipe',
        stderr: 'pipe',
      });
      for (let index = 0; index < 200 && !existsSync(held); index += 1) {
        await Bun.sleep(10);
      }
      expect(existsSync(held)).toBe(true);
      const second = Bun.spawn(['bun', runner, root, 'second'], {
        stdout: 'pipe',
        stderr: 'pipe',
      });
      for (let index = 0; index < 200 && !existsSync(waited); index += 1) {
        await Bun.sleep(10);
      }
      writeFileSync(release, 'release');
      expect(existsSync(waited)).toBe(true);
      const [firstCode, secondCode] = await Promise.all([
        first.exited,
        second.exited,
      ]);
      expect(firstCode).toBe(0);
      expect(secondCode).toBe(0);
      const after = digestFiles(root);
      await generateModule.generateContracts({ packageRoot: root });
      expect(digestFiles(root)).toEqual(after);
      expect(generationResidue(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true });
    }
  }, 60_000);

  test('rejects a stale writer by validating its precondition under the lock', async () => {
    expect(generateModule).toBeDefined();
    if (generateModule === undefined) return;
    const root = mkdtempSync(join(tmpdir(), 'colorful-preflight-lock-'));
    const initialManifest = '{"version":0}\n';
    const v1Manifest = '{"version":1}\n';
    let signalHeld!: () => void;
    let releaseV1!: () => void;
    let signalCollision!: () => void;
    const held = new Promise<void>((resolve) => {
      signalHeld = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseV1 = resolve;
    });
    const collision = new Promise<void>((resolve) => {
      signalCollision = resolve;
    });
    const preflight = () => {
      if (readFileSync(join(root, 'manifest.json'), 'utf8') !== initialManifest) {
        throw new Error('stale generated-output precondition');
      }
    };
    try {
      await generateModule.publishGeneratedOutputs(root, {
        'manifest.json': initialManifest,
        'valid/a.json': 'a\n',
      });
      const v1 = generateModule.publishGeneratedOutputs(
        root,
        {
          'manifest.json': v1Manifest,
          'valid/a.json': 'a\n',
          'valid/x.json': 'x\n',
        },
        {
          preflightUnderLock: preflight,
          dependencies: {
            afterLockAcquired: async () => {
              signalHeld();
              await release;
            },
          },
        },
      );
      await held;
      const staleV0 = generateModule.publishGeneratedOutputs(
        root,
        {
          'manifest.json': initialManifest,
          'valid/a.json': 'a\n',
        },
        {
          preflightUnderLock: preflight,
          dependencies: { onLockCollision: signalCollision },
        },
      );
      await collision;
      releaseV1();

      await v1;
      await expect(staleV0).rejects.toThrow(/stale.*precondition/i);
      expect(readFileSync(join(root, 'manifest.json'), 'utf8')).toBe(
        v1Manifest,
      );
      expect(readFileSync(join(root, 'valid/a.json'), 'utf8')).toBe('a\n');
      expect(readFileSync(join(root, 'valid/x.json'), 'utf8')).toBe('x\n');
      expect(generationResidue(root)).toEqual([]);
    } finally {
      releaseV1?.();
      rmSync(root, { recursive: true });
    }
  });

  test('fails safely for active, foreign and malformed locks', async () => {
    expect(generateModule).toBeDefined();
    if (generateModule === undefined) return;
    const root = mkdtempSync(join(tmpdir(), 'colorful-lock-safe-'));
    const lockPath = join(root, '.schema-generation.lock');
    try {
      const fixtures = [
        {
          pid: process.pid,
          hostname: hostname(),
          nonce: 'active',
          createdAt: 0,
        },
        {
          pid: 999999,
          hostname: hostname(),
          nonce: 'too-new',
          createdAt: 9_999,
        },
        {
          pid: 999999,
          hostname: 'foreign-host',
          nonce: 'foreign',
          createdAt: 0,
        },
        'not-json-with-secret-value',
      ];
      for (const fixture of fixtures) {
        writeFileSync(
          lockPath,
          typeof fixture === 'string' ? fixture : JSON.stringify(fixture),
        );
        try {
          await generateModule.publishGeneratedOutputs(
            root,
            { 'generated/openapi.v2.json': '{}\n' },
            {
              lockTimeoutMs: 0,
              staleLockMs: 1,
              dependencies: { now: () => 10_000 },
            },
          );
          throw new Error('expected lock acquisition to fail');
        } catch (error) {
          expect(String(error)).toMatch(/generation lock/i);
          expect(String(error)).not.toContain('secret-value');
        }
        expect(readFileSync(lockPath, 'utf8')).toBe(
          typeof fixture === 'string' ? fixture : JSON.stringify(fixture),
        );
      }
    } finally {
      rmSync(root, { recursive: true });
    }
  });

  test('quarantines a stale same-host dead owner and recovers', async () => {
    expect(generateModule).toBeDefined();
    if (generateModule === undefined) return;
    const root = mkdtempSync(join(tmpdir(), 'colorful-lock-recover-'));
    try {
      writeFileSync(
        join(root, '.schema-generation.lock'),
        JSON.stringify({
          pid: 999999,
          hostname: hostname(),
          nonce: 'stale',
          createdAt: 0,
        }),
      );
      await generateModule.publishGeneratedOutputs(
        root,
        { 'generated/openapi.v2.json': '{"ok":true}\n' },
        {
          lockTimeoutMs: 0,
          staleLockMs: 1,
          dependencies: { now: () => 10_000, pidIsAlive: () => false },
        },
      );
      expect(
        readFileSync(join(root, 'generated/openapi.v2.json'), 'utf8'),
      ).toBe('{"ok":true}\n');
      expect(() =>
        readFileSync(join(root, '.schema-generation.lock')),
      ).toThrow();
    } finally {
      rmSync(root, { recursive: true });
    }
  });

  test('records createdAt when exclusive open succeeds after waiting', async () => {
    expect(generateModule).toBeDefined();
    if (generateModule === undefined) return;
    const root = mkdtempSync(join(tmpdir(), 'colorful-lock-created-at-'));
    const lockPath = join(root, '.schema-generation.lock');
    let currentTime = 100;
    let lockAttempts = 0;
    let observedCreatedAt: number | undefined;
    try {
      writeFileSync(
        lockPath,
        JSON.stringify({
          pid: process.pid,
          hostname: hostname(),
          nonce: 'first-owner',
          createdAt: currentTime,
        }),
      );
      await generateModule.publishGeneratedOutputs(
        root,
        { 'generated/openapi.v2.json': '{}\n' },
        {
          lockTimeoutMs: 1_000,
          dependencies: {
            now: () => currentTime,
            tryLock: () => {
              lockAttempts += 1;
              return lockAttempts > 1;
            },
            sleep: async () => {
              currentTime = 500;
              rmSync(lockPath);
            },
            rename: (_from: string, to: string) => {
              if (to.endsWith('openapi.v2.json')) {
                observedCreatedAt = JSON.parse(
                  readFileSync(lockPath, 'utf8'),
                ).createdAt;
              }
            },
          },
        },
      );
      expect(observedCreatedAt).toBe(500);
    } finally {
      rmSync(root, { recursive: true });
    }
  });

  test('bounds advisory-lock waiting with a monotonic clock', async () => {
    expect(generateModule).toBeDefined();
    if (generateModule === undefined) return;
    const root = mkdtempSync(join(tmpdir(), 'colorful-lock-monotonic-'));
    let monotonicTime = 0;
    let wallTime = 10_000;
    let attempts = 0;
    try {
      await expect(
        generateModule.publishGeneratedOutputs(
          root,
          { 'generated/openapi.v2.json': '{}\n' },
          {
            lockTimeoutMs: 50,
            dependencies: {
              monotonicNow: () => monotonicTime,
              now: () => wallTime,
              tryLock: () => {
                attempts += 1;
                return false;
              },
              sleep: async (milliseconds: number) => {
                monotonicTime += milliseconds;
                wallTime -= 1_000;
              },
            },
          },
        ),
      ).rejects.toThrow(/owner is active/i);
      expect(attempts).toBe(3);
      expect(monotonicTime).toBe(50);
      expect(generationResidue(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true });
    }
  });

  test('fails closed if the package root changes while waiting for flock', async () => {
    expect(generateModule).toBeDefined();
    if (generateModule === undefined) return;
    const parent = mkdtempSync(join(tmpdir(), 'colorful-root-drift-'));
    const root = join(parent, 'root');
    const movedRoot = join(parent, 'moved-root');
    mkdirSync(root);
    let replaced = false;
    try {
      await expect(
        generateModule.publishGeneratedOutputs(
          root,
          { 'generated/openapi.v2.json': '{}\n' },
          {
            dependencies: {
              tryLock: () => {
                if (!replaced) {
                  replaced = true;
                  renameSync(root, movedRoot);
                  mkdirSync(root);
                }
                return true;
              },
            },
          },
        ),
      ).rejects.toThrow(/root changed/i);
      expect(existsSync(join(root, 'generated/openapi.v2.json'))).toBe(false);
    } finally {
      rmSync(parent, { recursive: true });
    }
  });

  test('rolls back every target if promotion fails midway', async () => {
    expect(generateModule).toBeDefined();
    if (generateModule === undefined) return;
    const root = mkdtempSync(join(tmpdir(), 'colorful-promotion-rollback-'));
    const outputs = Object.fromEntries(
      GENERATED_PATHS.map((path) => [path, `new:${path}\n`]),
    );
    for (const path of GENERATED_PATHS) {
      mkdirSync(join(root, path, '..'), { recursive: true });
      writeFileSync(join(root, path), `old:${path}\n`);
    }
    let promoted = 0;
    try {
      await expect(
        generateModule.publishGeneratedOutputs(root, outputs, {
          dependencies: {
            rename: (from: string) => {
              if (
                from.includes('.schema-generation.staging-') &&
                !from.includes('/backup/')
              ) {
                promoted += 1;
                if (promoted === 2)
                  throw new Error('injected promotion failure');
              }
            },
          },
        }),
      ).rejects.toThrow('injected promotion failure');
      for (const path of GENERATED_PATHS) {
        expect(readFileSync(join(root, path), 'utf8')).toBe(`old:${path}\n`);
      }
      expect(generationResidue(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true });
    }
  });

  test('rollback keeps a target absent when it did not exist before promotion', async () => {
    expect(generateModule).toBeDefined();
    if (generateModule === undefined) return;
    const root = mkdtempSync(join(tmpdir(), 'colorful-rollback-absent-'));
    let promoted = 0;
    try {
      await expect(
        generateModule.publishGeneratedOutputs(
          root,
          {
            'generated/first.json': 'first\n',
            'generated/second.json': 'second\n',
          },
          {
            dependencies: {
              rename: (from: string) => {
                if (from.includes('.schema-generation.staging-')) {
                  promoted += 1;
                  if (promoted === 2) throw new Error('fail second install');
                }
              },
            },
          },
        ),
      ).rejects.toThrow('fail second install');
      expect(existsSync(join(root, 'generated/first.json'))).toBe(false);
      expect(existsSync(join(root, 'generated/second.json'))).toBe(false);
      expect(generationResidue(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true });
    }
  });

  test('preserves a single promotion error identity and orders cleanup errors', async () => {
    expect(generateModule).toBeDefined();
    if (generateModule === undefined) return;
    for (const includeUnlockFailure of [false, true]) {
      const root = mkdtempSync(join(tmpdir(), 'colorful-error-order-'));
      const promotionError = new Error('primary promotion error');
      const unlockError = new Error('secondary unlock error');
      let injected = false;
      let caught: unknown;
      try {
        await generateModule.publishGeneratedOutputs(
          root,
          { 'generated/output.json': '{}\n' },
          {
            dependencies: {
              rename: () => {
                if (!injected) {
                  injected = true;
                  throw promotionError;
                }
              },
              ...(includeUnlockFailure
                ? {
                    unlock: () => {
                      throw unlockError;
                    },
                  }
                : {}),
            },
          },
        );
      } catch (error) {
        caught = error;
      }
      if (includeUnlockFailure) {
        expect(caught).toBeInstanceOf(AggregateError);
        expect((caught as AggregateError).errors).toEqual([
          promotionError,
          unlockError,
        ]);
      } else {
        expect(caught).toBe(promotionError);
      }
      expect(generationResidue(root)).toEqual([]);
      rmSync(root, { recursive: true });
    }
  });

  test('recovers after a process crashes while holding stale-lock exclusion', async () => {
    expect(generateModule).toBeDefined();
    if (generateModule === undefined) return;
    const root = mkdtempSync(join(tmpdir(), 'colorful-flock-crash-'));
    const runner = join(root, 'crash.ts');
    const marker = join(root, 'crashed.marker');
    const moduleUrl = new URL('../scripts/generate.ts', import.meta.url).href;
    try {
      writeFileSync(
        join(root, '.schema-generation.lock'),
        JSON.stringify({
          pid: 999999,
          hostname: hostname(),
          nonce: 'stale',
          createdAt: 0,
        }),
      );
      writeFileSync(
        runner,
        `import { writeFileSync } from 'node:fs'; import { publishGeneratedOutputs } from ${JSON.stringify(moduleUrl)};
await publishGeneratedOutputs(process.argv[2], { 'generated/a.json': 'a\\n' }, { lockTimeoutMs: 0, staleLockMs: 0, dependencies: { pidIsAlive: () => false, afterStaleInspect: async () => { writeFileSync(${JSON.stringify(marker)}, 'held'); process.kill(process.pid, 'SIGKILL'); } } });`,
      );
      const crashed = Bun.spawn(['bun', runner, root], {
        stdout: 'pipe',
        stderr: 'pipe',
      });
      expect(await crashed.exited).not.toBe(0);
      expect(existsSync(marker)).toBe(true);
      await generateModule.publishGeneratedOutputs(
        root,
        { 'generated/b.json': 'b\n' },
        {
          lockTimeoutMs: 0,
          staleLockMs: 0,
          dependencies: { pidIsAlive: () => false },
        },
      );
      expect(readFileSync(join(root, 'generated/b.json'), 'utf8')).toBe('b\n');
      expect(
        generationResidue(root).filter(
          (name) => !name.startsWith('.schema-generation.staging-'),
        ),
      ).toEqual([]);
    } finally {
      rmSync(root, { recursive: true });
    }
  });

  test('does not delete a lock whose nonce changes before release', async () => {
    expect(generateModule).toBeDefined();
    if (generateModule === undefined) return;
    const root = mkdtempSync(join(tmpdir(), 'colorful-lock-owner-'));
    const lockPath = join(root, '.schema-generation.lock');
    let changed = false;
    try {
      await expect(
        generateModule.publishGeneratedOutputs(
          root,
          { 'generated/openapi.v2.json': '{}\n' },
          {
            dependencies: {
              rename: (from: string, to: string) => {
                if (!changed && to.endsWith('openapi.v2.json')) {
                  changed = true;
                  writeFileSync(
                    lockPath,
                    JSON.stringify({
                      pid: 1,
                      hostname: 'new',
                      nonce: 'new-owner',
                      createdAt: 1,
                    }),
                  );
                }
              },
            },
          },
        ),
      ).rejects.toThrow(/ownership changed/i);
      expect(JSON.parse(readFileSync(lockPath, 'utf8')).nonce).toBe(
        'new-owner',
      );
    } finally {
      rmSync(root, { recursive: true });
    }
  });

  test('fails closed on traversal and linked lock, root, parent or targets', async () => {
    expect(generateModule).toBeDefined();
    if (generateModule === undefined) return;
    const root = mkdtempSync(join(tmpdir(), 'colorful-path-safe-'));
    const outside = join(root, 'outside');
    writeFileSync(outside, 'outside');
    try {
      await expect(
        generateModule.publishGeneratedOutputs(root, { '../escape': 'bad' }),
      ).rejects.toThrow(/path/i);
      expect(generationResidue(root)).toEqual([]);

      symlinkSync(outside, join(root, '.schema-generation.lock'));
      await expect(
        generateModule.publishGeneratedOutputs(
          root,
          { 'generated/openapi.v2.json': '{}\n' },
          { lockTimeoutMs: 0 },
        ),
      ).rejects.toThrow(/lock.*symbolic link/i);
      rmSync(join(root, '.schema-generation.lock'));

      linkSync(outside, join(root, '.schema-generation.lock'));
      await expect(
        generateModule.publishGeneratedOutputs(
          root,
          { 'generated/openapi.v2.json': '{}\n' },
          { lockTimeoutMs: 0 },
        ),
      ).rejects.toThrow(/lock.*regular file/i);
      rmSync(join(root, '.schema-generation.lock'));

      symlinkSync(root, join(root, 'linked-root'));
      await expect(
        generateModule.publishGeneratedOutputs(join(root, 'linked-root'), {
          'generated/openapi.v2.json': '{}\n',
        }),
      ).rejects.toThrow(/root/i);
      rmSync(join(root, 'linked-root'));

      symlinkSync(outside, join(root, 'generated'));
      await expect(
        generateModule.publishGeneratedOutputs(root, {
          'generated/openapi.v2.json': '{}\n',
        }),
      ).rejects.toThrow(/parent/i);
      rmSync(join(root, 'generated'));

      mkdirSync(join(root, 'generated'), { recursive: true });
      symlinkSync(outside, join(root, 'generated/openapi.v2.json'));
      await expect(
        generateModule.publishGeneratedOutputs(root, {
          'generated/openapi.v2.json': '{}\n',
        }),
      ).rejects.toThrow(/symbolic link/i);
      rmSync(join(root, 'generated/openapi.v2.json'));

      linkSync(outside, join(root, 'generated/openapi.v2.json'));
      await expect(
        generateModule.publishGeneratedOutputs(root, {
          'generated/openapi.v2.json': '{}\n',
        }),
      ).rejects.toThrow(/hard link/i);
      expect(readFileSync(outside, 'utf8')).toBe('outside');
      expect(generationResidue(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true });
    }
  });

  test('binds promotion to the inspected parent inode when an attacker swaps the pathname', async () => {
    expect(generateModule).toBeDefined();
    if (generateModule === undefined) return;
    const root = mkdtempSync(join(tmpdir(), 'colorful-parent-swap-'));
    const outside = mkdtempSync(join(tmpdir(), 'colorful-parent-outside-'));
    const generated = join(root, 'generated');
    const displaced = join(root, 'generated.displaced');
    mkdirSync(generated);
    writeFileSync(join(generated, 'value.json'), 'old\n');
    try {
      await generateModule.publishGeneratedOutputs(
        root,
        { 'generated/value.json': 'new\n' },
        {
          dependencies: {
            afterTargetInspect: async () => {
              renameSync(generated, displaced);
              symlinkSync(outside, generated);
            },
          },
        },
      );
      expect(readFileSync(join(displaced, 'value.json'), 'utf8')).toBe('new\n');
      expect(existsSync(join(outside, 'value.json'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test('recovers the old generation after SIGKILL interrupts promotion', async () => {
    expect(generateModule).toBeDefined();
    if (generateModule === undefined) return;
    const root = mkdtempSync(join(tmpdir(), 'colorful-promotion-crash-'));
    const runner = join(root, 'crash-promotion.ts');
    const marker = join(root, 'promotion.marker');
    const recoveryRunner = join(root, 'crash-recovery.ts');
    const recoveryMarker = join(root, 'recovery.marker');
    const moduleUrl = new URL('../scripts/generate.ts', import.meta.url).href;
    const outputs = {
      'generated/first.json': 'new:first\n',
      'generated/second.json': 'new:second\n',
    };
    mkdirSync(join(root, 'generated'));
    writeFileSync(join(root, 'generated/first.json'), 'old:first\n');
    writeFileSync(join(root, 'generated/second.json'), 'old:second\n');
    writeFileSync(
      runner,
      `import { writeFileSync } from 'node:fs'; import { publishGeneratedOutputs } from ${JSON.stringify(moduleUrl)};
await publishGeneratedOutputs(process.argv[2], ${JSON.stringify(outputs)}, { dependencies: { afterPromotionStep: async (step) => { if (step === 1) { writeFileSync(${JSON.stringify(marker)}, 'interrupted'); process.kill(process.pid, 'SIGKILL'); } } } });`,
    );
    writeFileSync(
      recoveryRunner,
      `import { writeFileSync } from 'node:fs'; import { publishGeneratedOutputs } from ${JSON.stringify(moduleUrl)};
await publishGeneratedOutputs(process.argv[2], { 'generated/third.json': 'new:third\\n' }, { dependencies: { rename: (_from, to) => { if (to.includes('recovery-discard-0')) { writeFileSync(${JSON.stringify(recoveryMarker)}, 'interrupted'); process.kill(process.pid, 'SIGKILL'); } } } });`,
    );
    try {
      const crashed = Bun.spawn(['bun', runner, root], {
        stdout: 'pipe',
        stderr: 'pipe',
      });
      expect(await crashed.exited).not.toBe(0);
      expect(existsSync(marker)).toBe(true);

      const recoveryCrashed = Bun.spawn(['bun', recoveryRunner, root], {
        stdout: 'pipe',
        stderr: 'pipe',
      });
      expect(await recoveryCrashed.exited).not.toBe(0);
      expect(existsSync(recoveryMarker)).toBe(true);

      await generateModule.publishGeneratedOutputs(root, {
        'generated/third.json': 'new:third\n',
      });

      expect(readFileSync(join(root, 'generated/first.json'), 'utf8')).toBe(
        'old:first\n',
      );
      expect(readFileSync(join(root, 'generated/second.json'), 'utf8')).toBe(
        'old:second\n',
      );
      expect(readFileSync(join(root, 'generated/third.json'), 'utf8')).toBe(
        'new:third\n',
      );
      expect(generationResidue(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test('rejects generated outputs in the reserved transaction namespace', async () => {
    expect(generateModule).toBeDefined();
    if (generateModule === undefined) return;
    const root = mkdtempSync(join(tmpdir(), 'colorful-reserved-output-'));
    try {
      await expect(
        generateModule.publishGeneratedOutputs(root, {
          '.schema-generation.attacker/value': 'bad\n',
        }),
      ).rejects.toThrow(/reserved/i);
      expect(generationResidue(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('recovers a committed journal after staging cleanup was SIGKILLed', async () => {
    expect(generateModule).toBeDefined();
    if (generateModule === undefined) return;
    const root = mkdtempSync(join(tmpdir(), 'colorful-committed-crash-'));
    const runner = join(root, 'committed-crash.ts');
    const moduleUrl = new URL('../scripts/generate.ts', import.meta.url).href;
    writeFileSync(
      runner,
      `import { publishGeneratedOutputs } from ${JSON.stringify(moduleUrl)}; await publishGeneratedOutputs(process.argv[2], { 'generated/first': 'new\\n' }, { dependencies: { afterStagingCleanup: async () => process.kill(process.pid, 'SIGKILL') } });`,
    );
    try {
      const crashed = Bun.spawn(['bun', runner, root]);
      expect(await crashed.exited).not.toBe(0);
      await generateModule.publishGeneratedOutputs(root, {
        'generated/second': 'second\n',
      });
      expect(readFileSync(join(root, 'generated/first'), 'utf8')).toBe('new\n');
      expect(readFileSync(join(root, 'generated/second'), 'utf8')).toBe(
        'second\n',
      );
      expect(generationResidue(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test('garbage collects a dead same-host staging owner killed before journaling', async () => {
    expect(generateModule).toBeDefined();
    if (generateModule === undefined) return;
    const root = mkdtempSync(join(tmpdir(), 'colorful-orphan-staging-'));
    const runner = join(root, 'orphan-crash.ts');
    const moduleUrl = new URL('../scripts/generate.ts', import.meta.url).href;
    writeFileSync(
      runner,
      `import { publishGeneratedOutputs } from ${JSON.stringify(moduleUrl)}; await publishGeneratedOutputs(process.argv[2], { 'generated/first': 'new\\n' }, { dependencies: { afterStagingPrepared: async () => process.kill(process.pid, 'SIGKILL') } });`,
    );
    try {
      const crashed = Bun.spawn(['bun', runner, root]);
      expect(await crashed.exited).not.toBe(0);
      await generateModule.publishGeneratedOutputs(root, {
        'generated/second': 'second\n',
      });
      expect(generationResidue(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test('fails closed when an inspected orphan staging pathname is replaced before cleanup', async () => {
    expect(generateModule).toBeDefined();
    if (generateModule === undefined) return;
    const root = mkdtempSync(join(tmpdir(), 'colorful-orphan-swap-'));
    const deadPid = 999999;
    const token = (value: string) =>
      createHash('sha256').update(value).digest('hex').slice(0, 16);
    const orphanName = `.schema-generation.staging-${deadPid}-${token(
      hostname(),
    )}-${token('dead-orphan')}`;
    const orphanPath = join(root, orphanName);
    const displacedPath = join(root, `${orphanName}.displaced`);
    mkdirSync(orphanPath);
    try {
      await expect(
        generateModule.publishGeneratedOutputs(
          root,
          { 'generated/new': 'new\n' },
          {
            dependencies: {
              pidIsAlive: () => false,
              afterLockAcquired: async () => {
                renameSync(orphanPath, displacedPath);
                mkdirSync(orphanPath);
                writeFileSync(join(orphanPath, 'valuable'), 'keep\n');
              },
            },
          },
        ),
      ).rejects.toThrow(/orphan staging.*changed|identity/i);
      expect(readFileSync(join(orphanPath, 'valuable'), 'utf8')).toBe('keep\n');
      expect(existsSync(join(root, 'generated/new'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('never treats a journal target directory as an absent regular file', async () => {
    expect(generateModule).toBeDefined();
    if (generateModule === undefined) return;
    const root = mkdtempSync(join(tmpdir(), 'colorful-journal-directory-'));
    const staging = '.schema-generation.staging-999999-malicious';
    mkdirSync(join(root, 'generated'));
    writeFileSync(join(root, 'generated/valuable'), 'keep\n');
    mkdirSync(join(root, staging, 'backup'), { recursive: true });
    writeFileSync(
      join(root, '.schema-generation.transaction'),
      JSON.stringify({
        version: 1,
        state: 'prepared',
        staging,
        entries: [
          {
            target: 'generated',
            staged: `${staging}/generated`,
            backup: `${staging}/backup/0`,
            hadOriginal: false,
          },
        ],
      }),
    );
    writeFileSync(
      join(root, '.schema-generation.lock'),
      JSON.stringify({
        pid: 999999,
        hostname: hostname(),
        nonce: 'dead',
        createdAt: 0,
      }),
    );
    try {
      await expect(
        generateModule.publishGeneratedOutputs(
          root,
          { 'generated/new': 'new\n' },
          { dependencies: { pidIsAlive: () => false } },
        ),
      ).rejects.toThrow(/regular file/i);
      expect(readFileSync(join(root, 'generated/valuable'), 'utf8')).toBe(
        'keep\n',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('recovers when durability fails after the prepared journal rename', async () => {
    expect(generateModule).toBeDefined();
    if (generateModule === undefined) return;
    const root = mkdtempSync(join(tmpdir(), 'colorful-journal-fsync-'));
    try {
      await expect(
        generateModule.publishGeneratedOutputs(
          root,
          { 'generated/first': 'first\n' },
          {
            dependencies: {
              afterPreparedJournalRename: () => {
                throw new Error('injected root fsync failure');
              },
            },
          },
        ),
      ).rejects.toThrow('injected root fsync failure');
      await generateModule.publishGeneratedOutputs(root, {
        'generated/second': 'second\n',
      });
      expect(existsSync(join(root, 'generated/first'))).toBe(false);
      expect(readFileSync(join(root, 'generated/second'), 'utf8')).toBe(
        'second\n',
      );
      expect(generationResidue(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('garbage collects a dead same-host staging killed before its owner manifest', async () => {
    expect(generateModule).toBeDefined();
    if (generateModule === undefined) return;
    const root = mkdtempSync(join(tmpdir(), 'colorful-mkdir-crash-'));
    const runner = join(root, 'mkdir-crash.ts');
    const moduleUrl = new URL('../scripts/generate.ts', import.meta.url).href;
    writeFileSync(
      runner,
      `import { publishGeneratedOutputs } from ${JSON.stringify(moduleUrl)}; await publishGeneratedOutputs(process.argv[2], { 'generated/first': 'first\\n' }, { dependencies: { afterStagingMkdir: async () => process.kill(process.pid, 'SIGKILL') } });`,
    );
    try {
      const crashed = Bun.spawn(['bun', runner, root]);
      expect(await crashed.exited).not.toBe(0);
      await generateModule.publishGeneratedOutputs(root, {
        'generated/second': 'second\n',
      });
      expect(generationResidue(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
