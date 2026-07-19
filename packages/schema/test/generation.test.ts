import { describe, expect, test } from 'bun:test';
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
