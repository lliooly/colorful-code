import { z } from 'zod';

import {
  httpContractRegistry,
  type HttpContractDescriptor,
} from './commands.js';
import * as contracts from './index.js';

export type SchemaRegistry = Readonly<Record<string, z.ZodType>>;
export type HttpRegistry = Readonly<
  Record<string, Frozen<HttpContractDescriptor>>
>;
export type EventSchemaRegistry = Readonly<Record<string, z.ZodType>>;
export type ContractRegistry = Readonly<{
  events: EventSchemaRegistry;
  http: HttpRegistry;
  schemas: SchemaRegistry;
}>;

type ZodInternals = {
  readonly def: Readonly<Record<string, unknown>> & {
    readonly type?: string;
    readonly checks?: readonly unknown[];
  };
};

const asZodSchema = (value: unknown): z.ZodType | undefined =>
  value instanceof z.ZodType ? value : undefined;

const customCheck = (value: unknown) => {
  const schema = asZodSchema(value);
  if (schema === undefined) return false;
  const internals = (schema as unknown as { _zod: ZodInternals })._zod;
  return internals.def.type === 'custom';
};

export const unsupportedJsonSchemaPath = (
  schema: z.ZodType,
  path = '$',
  visited = new Map<z.ZodType, number>(),
  requiresStructuralOutput = false,
): string | undefined => {
  const visitFlag = requiresStructuralOutput ? 2 : 1;
  const priorVisits = visited.get(schema) ?? 0;
  if ((priorVisits & visitFlag) !== 0) return undefined;
  visited.set(schema, priorVisits | visitFlag);

  const internals = (schema as unknown as { _zod: ZodInternals })._zod;
  const definition = internals.def;
  const type = definition.type;
  if (
    type === 'bigint' ||
    type === 'custom' ||
    type === 'function' ||
    type === 'symbol' ||
    type === 'transform'
  ) {
    return path;
  }
  if (requiresStructuralOutput && (type === 'any' || type === 'unknown')) {
    return path;
  }
  if (
    (type === 'any' || type === 'unknown') &&
    definition.checks?.some(customCheck) === true
  ) {
    return path;
  }

  const visit = (
    candidate: unknown,
    candidatePath = path,
    requiresStructure = requiresStructuralOutput,
  ) => {
    const nested = asZodSchema(candidate);
    return nested === undefined
      ? undefined
      : unsupportedJsonSchemaPath(
          nested,
          candidatePath,
          visited,
          requiresStructure,
        );
  };

  // Contract IR describes the value on the wire after parsing. Input-side
  // preprocessors/normalizers are safe to omit only when the output side is a
  // concrete structural schema. An output transform or unconstrained output
  // fails closed instead of silently becoming `{}`.
  if (type === 'pipe') return visit(definition.out, path, true);
  if (type === 'object') {
    const shape = definition.shape;
    if (shape !== null && typeof shape === 'object') {
      for (const [key, value] of Object.entries(shape)) {
        const failure = visit(value, `${path}.${key}`);
        if (failure !== undefined) return failure;
      }
    }
    return visit(definition.catchall, `${path}.*`);
  }
  if (type === 'array') return visit(definition.element, `${path}[]`);
  if (type === 'tuple' && Array.isArray(definition.items)) {
    for (const [index, item] of definition.items.entries()) {
      const failure = visit(item, `${path}[${index}]`);
      if (failure !== undefined) return failure;
    }
    return visit(definition.rest, `${path}[]`);
  }
  if (type === 'union' || type === 'discriminatedUnion' || type === 'xor') {
    if (!Array.isArray(definition.options)) return undefined;
    for (const option of definition.options) {
      const failure = visit(option);
      if (failure !== undefined) return failure;
    }
    return undefined;
  }
  if (type === 'intersection') {
    return visit(definition.left) ?? visit(definition.right);
  }
  if (type === 'record' || type === 'map') {
    return (
      visit(definition.keyType, `${path}.*`) ??
      visit(definition.valueType, `${path}.*`)
    );
  }
  if (type === 'set') return visit(definition.valueType, `${path}[]`);
  if (type === 'lazy') {
    const getter = definition.getter;
    return typeof getter === 'function'
      ? visit((getter as () => unknown)())
      : undefined;
  }

  return (
    visit(definition.innerType) ??
    visit(definition.schema) ??
    visit(definition.valueType)
  );
};

export type FrozenJson =
  | null
  | boolean
  | number
  | string
  | readonly FrozenJson[]
  | { readonly [key: string]: FrozenJson };

const freezeJsonSnapshot = (value: unknown): FrozenJson => {
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'string'
  ) {
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    return Object.freeze(value.map(freezeJsonSnapshot));
  }
  if (typeof value === 'object') {
    return Object.freeze(
      Object.fromEntries(
        Object.entries(value).map(([key, nested]) => [
          key,
          freezeJsonSnapshot(nested),
        ]),
      ),
    );
  }
  throw new TypeError('JSON Schema snapshot contains a non-JSON value');
};

export type SchemaSnapshotOutcome = Readonly<{
  conversionError?: string;
  jsonSchema?: FrozenJson;
  unsupportedPath?: string;
}>;

type Frozen<T> = T extends z.ZodType
  ? T
  : T extends (...arguments_: never[]) => unknown
    ? T
    : T extends object
      ? { readonly [Key in keyof T]: Frozen<T[Key]> }
      : T;

const schemaSnapshotOutcomes = new WeakMap<z.ZodType, SchemaSnapshotOutcome>();

const PROTO_PROPERTY_PLACEHOLDER = '\u0000colorful-code:__proto__';

type ZodCoreNode = Readonly<{
  _zod: Readonly<{
    constr: new (definition: unknown) => object;
    def: unknown;
  }>;
}>;

const asZodCoreNode = (value: object): ZodCoreNode | undefined => {
  const internals = Reflect.get(value, '_zod');
  if (internals === null || typeof internals !== 'object') return undefined;
  const definition = Reflect.get(internals, 'def');
  const constructor = Reflect.get(internals, 'constr');
  return definition !== undefined && typeof constructor === 'function'
    ? (value as ZodCoreNode)
    : undefined;
};

const immutableCollectionMutation = (): never => {
  throw new TypeError('isolated Zod definition collections are immutable');
};

const immutableSetBackings = new WeakMap<object, ReadonlySet<unknown>>();
const immutableMapBackings = new WeakMap<
  object,
  ReadonlyMap<unknown, unknown>
>();

const setBacking = <Value>(facade: object): ReadonlySet<Value> => {
  const backing = immutableSetBackings.get(facade);
  if (backing === undefined)
    throw new TypeError('invalid immutable Set facade');
  return backing as ReadonlySet<Value>;
};

const mapBacking = <Key, Value>(facade: object): ReadonlyMap<Key, Value> => {
  const backing = immutableMapBackings.get(facade);
  if (backing === undefined)
    throw new TypeError('invalid immutable Map facade');
  return backing as ReadonlyMap<Key, Value>;
};

class ImmutableSetFacade<Value> implements ReadonlySet<Value> {
  public constructor(backing: ReadonlySet<Value>) {
    immutableSetBackings.set(this, backing as ReadonlySet<unknown>);
  }

  public get size(): number {
    return setBacking<Value>(this).size;
  }

  public get [Symbol.toStringTag](): string {
    return 'Set';
  }

  public add(value: Value): this {
    void value;
    return immutableCollectionMutation();
  }

  public clear(): void {
    immutableCollectionMutation();
  }

  public delete(value: Value): boolean {
    void value;
    return immutableCollectionMutation();
  }

  public entries(): SetIterator<[Value, Value]> {
    return setBacking<Value>(this).entries();
  }

  public forEach(
    callback: (value: Value, key: Value, set: ReadonlySet<Value>) => void,
    thisArgument?: unknown,
  ): void {
    for (const value of setBacking<Value>(this)) {
      callback.call(thisArgument, value, value, this);
    }
  }

  public has(value: Value): boolean {
    return setBacking<Value>(this).has(value);
  }

  public keys(): SetIterator<Value> {
    return setBacking<Value>(this).keys();
  }

  public values(): SetIterator<Value> {
    return setBacking<Value>(this).values();
  }

  public [Symbol.iterator](): SetIterator<Value> {
    return this.values();
  }
}

class ImmutableMapFacade<Key, Value> implements ReadonlyMap<Key, Value> {
  public constructor(backing: ReadonlyMap<Key, Value>) {
    immutableMapBackings.set(this, backing as ReadonlyMap<unknown, unknown>);
  }

  public get size(): number {
    return mapBacking<Key, Value>(this).size;
  }

  public get [Symbol.toStringTag](): string {
    return 'Map';
  }

  public clear(): void {
    immutableCollectionMutation();
  }

  public delete(key: Key): boolean {
    void key;
    return immutableCollectionMutation();
  }

  public entries(): MapIterator<[Key, Value]> {
    return mapBacking<Key, Value>(this).entries();
  }

  public forEach(
    callback: (value: Value, key: Key, map: ReadonlyMap<Key, Value>) => void,
    thisArgument?: unknown,
  ): void {
    for (const [key, value] of mapBacking<Key, Value>(this)) {
      callback.call(thisArgument, value, key, this);
    }
  }

  public get(key: Key): Value | undefined {
    return mapBacking<Key, Value>(this).get(key);
  }

  public has(key: Key): boolean {
    return mapBacking<Key, Value>(this).has(key);
  }

  public keys(): MapIterator<Key> {
    return mapBacking<Key, Value>(this).keys();
  }

  public set(key: Key, value: Value): this {
    void key;
    void value;
    return immutableCollectionMutation();
  }

  public values(): MapIterator<Value> {
    return mapBacking<Key, Value>(this).values();
  }

  public [Symbol.iterator](): MapIterator<[Key, Value]> {
    return this.entries();
  }
}

Object.freeze(ImmutableSetFacade.prototype);
Object.freeze(ImmutableMapFacade.prototype);

const deeplyFreezeSchemaGraph = (root: z.ZodType): void => {
  const replacements = new WeakMap<object, object>();
  const objects: object[] = [];

  const normalizeValue = (value: unknown): unknown => {
    if (
      value === null ||
      (typeof value !== 'object' && typeof value !== 'function') ||
      typeof value === 'function'
    ) {
      return value;
    }
    const prior = replacements.get(value);
    if (prior !== undefined) return prior;

    if (value instanceof Map) {
      const backing = new Map<unknown, unknown>();
      const facade = new ImmutableMapFacade(backing);
      replacements.set(value, facade);
      objects.push(facade);
      for (const [key, nested] of value) {
        backing.set(normalizeValue(key), normalizeValue(nested));
      }
      return facade;
    }
    if (value instanceof Set) {
      const backing = new Set<unknown>();
      const facade = new ImmutableSetFacade(backing);
      replacements.set(value, facade);
      objects.push(facade);
      for (const nested of value) backing.add(normalizeValue(nested));
      return facade;
    }

    // Zod deliberately writes RegExp.lastIndex = 0 before every regex check.
    // Its source/flags are already immutable and lastIndex cannot influence a
    // parse because Zod resets it, so treating RegExp as an atomic value keeps
    // regex validators operational without exposing semantic mutability.
    if (value instanceof RegExp) return value;

    replacements.set(value, value);
    objects.push(value);

    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined) continue;
      let nested: unknown;
      if ('value' in descriptor) {
        nested = descriptor.value;
      } else if (descriptor.get !== undefined) {
        // Zod uses memoizing getters for shape/value caches. Resolve them while
        // the complete graph is writable, then freeze the stable object they
        // expose in a separate pass. A one-pass DFS can freeze a shared `def`
        // before a later getter writes its `_cachedInner` field.
        nested = Reflect.get(value, key, value);
      } else {
        continue;
      }

      const normalized = normalizeValue(nested);
      if (normalized === nested) continue;
      if ('value' in descriptor) {
        if (descriptor.configurable !== true && descriptor.writable !== true) {
          throw new TypeError(
            `cannot replace mutable collection at non-writable Zod property ${String(key)}`,
          );
        }
        Object.defineProperty(value, key, { ...descriptor, value: normalized });
      } else {
        if (descriptor.configurable !== true) {
          throw new TypeError(
            `cannot replace mutable collection returned by Zod getter ${String(key)}`,
          );
        }
        Object.defineProperty(value, key, {
          configurable: true,
          enumerable: descriptor.enumerable,
          value: normalized,
          writable: true,
        });
      }
    }
    return value;
  };

  if (normalizeValue(root) !== root) {
    throw new TypeError('isolated Zod schema root cannot be a collection');
  }
  for (const value of objects.reverse()) {
    Object.freeze(value);
  }
};

const cloneSchemaGraph = <Schema extends z.ZodType>(
  schema: Schema,
  options: Readonly<{ escapeProtoProperties?: boolean }> = {},
): Readonly<{ escapedProtoProperties: boolean; schema: Schema }> => {
  const schemas = new WeakMap<z.ZodType, z.ZodType>();
  const containers = new WeakMap<object, object>();
  const cloning = new WeakSet<z.ZodType>();
  const forwarders = new WeakMap<z.ZodType, z.ZodType>();
  let escapedProtoProperties = false;

  const cloneValue = (value: unknown): unknown => {
    if (value instanceof z.ZodType) return cloneSchema(value);
    if (value === null || typeof value !== 'object') return value;
    const prior = containers.get(value);
    if (prior !== undefined) return prior;

    // Checks are Zod core instances too, but are not `ZodType`s. Re-running
    // their constructor is essential: `_zod.check` closes over the definition
    // passed to the constructor, so descriptor-copying the instance would keep
    // validating against the mutable authoring definition.
    const coreNode = asZodCoreNode(value);
    if (coreNode !== undefined) {
      const clonedDefinition = cloneValue(coreNode._zod.def);
      const cloned = new coreNode._zod.constr(clonedDefinition);
      containers.set(value, cloned);
      return cloned;
    }

    if (Array.isArray(value)) {
      const cloned: unknown[] = [];
      containers.set(value, cloned);
      for (const item of value) cloned.push(cloneValue(item));
      return cloned;
    }

    if (value instanceof RegExp) {
      const cloned = new RegExp(value.source, value.flags);
      cloned.lastIndex = value.lastIndex;
      containers.set(value, cloned);
      return cloned;
    }
    if (value instanceof Date) {
      const cloned = new Date(value.getTime());
      containers.set(value, cloned);
      return cloned;
    }
    if (value instanceof URL) {
      const cloned = new URL(value.href);
      containers.set(value, cloned);
      return cloned;
    }
    if (value instanceof Map) {
      const cloned = new Map<unknown, unknown>();
      containers.set(value, cloned);
      for (const [key, nested] of value) {
        cloned.set(cloneValue(key), cloneValue(nested));
      }
      return cloned;
    }
    if (value instanceof Set) {
      const cloned = new Set<unknown>();
      containers.set(value, cloned);
      for (const nested of value) cloned.add(cloneValue(nested));
      return cloned;
    }
    if (
      value instanceof WeakMap ||
      value instanceof WeakSet ||
      value instanceof Promise
    ) {
      throw new TypeError(
        `cannot isolate ${value.constructor.name} stored in a Zod definition`,
      );
    }
    if (value instanceof ArrayBuffer) {
      const cloned = value.slice(0);
      containers.set(value, cloned);
      return cloned;
    }
    if (ArrayBuffer.isView(value)) {
      const cloned = structuredClone(value) as object;
      containers.set(value, cloned);
      return cloned;
    }

    const prototype = Object.getPrototypeOf(value);
    const cloned = Object.create(prototype) as Record<PropertyKey, unknown>;
    containers.set(value, cloned);
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined) continue;
      Object.defineProperty(
        cloned,
        key,
        'value' in descriptor
          ? {
              configurable: true,
              enumerable: descriptor.enumerable,
              value: cloneValue(descriptor.value),
              writable: true,
            }
          : descriptor.get === undefined
            ? {
                configurable: true,
                enumerable: descriptor.enumerable,
                value: undefined,
                writable: true,
              }
            : {
                configurable: true,
                enumerable: descriptor.enumerable,
                value: cloneValue(Reflect.get(value, key, value)),
                writable: true,
              },
      );
    }
    return cloned;
  };

  const cloneSchema = <Nested extends z.ZodType>(original: Nested): Nested => {
    const prior = schemas.get(original);
    if (prior !== undefined) {
      if (!cloning.has(original)) return prior as Nested;
      const existingForwarder = forwarders.get(original);
      if (existingForwarder !== undefined) return existingForwarder as Nested;
      const forwarder = Object.freeze(
        z.lazy(() => {
          const resolved = schemas.get(original);
          if (resolved === undefined) {
            throw new Error('isolated recursive schema target is unavailable');
          }
          return resolved;
        }),
      );
      forwarders.set(original, forwarder);
      return forwarder as unknown as Nested;
    }

    const originalDefinition = original._zod.def;
    const inspectedDefinition = originalDefinition as ZodInternals['def'];
    const provisionalDefinition = Object.create(
      Object.getPrototypeOf(originalDefinition),
    ) as typeof originalDefinition;
    for (const key of Reflect.ownKeys(originalDefinition)) {
      const descriptor = Object.getOwnPropertyDescriptor(
        originalDefinition,
        key,
      );
      if (descriptor === undefined) continue;
      Object.defineProperty(provisionalDefinition, key, {
        ...descriptor,
        configurable: true,
        ...('value' in descriptor ? { writable: true } : {}),
      });
    }
    const provisional = z.core.clone(original, provisionalDefinition, {
      parent: false,
    });
    schemas.set(original, provisional);
    cloning.add(original);
    const clonedDefinition = cloneValue(
      originalDefinition,
    ) as typeof originalDefinition;

    if (
      options.escapeProtoProperties === true &&
      inspectedDefinition.type === 'object'
    ) {
      const shape = (clonedDefinition as ZodInternals['def']).shape;
      if (shape !== null && typeof shape === 'object') {
        if (Object.hasOwn(shape, PROTO_PROPERTY_PLACEHOLDER)) {
          throw new TypeError(
            `object shape uses reserved proto placeholder ${JSON.stringify(PROTO_PROPERTY_PLACEHOLDER)}`,
          );
        }
        const descriptor = Object.getOwnPropertyDescriptor(shape, '__proto__');
        if (descriptor !== undefined) {
          Object.defineProperty(shape, PROTO_PROPERTY_PLACEHOLDER, descriptor);
          Reflect.deleteProperty(shape, '__proto__');
          escapedProtoProperties = true;
        }
      }
    }

    if (
      inspectedDefinition.type === 'lazy' &&
      typeof inspectedDefinition.getter === 'function'
    ) {
      const getter = inspectedDefinition.getter as () => z.ZodType;
      const target = getter();
      cloneSchema(target);
      Object.defineProperty(clonedDefinition, 'getter', {
        configurable: true,
        enumerable: true,
        value: () => {
          const clonedTarget = schemas.get(target);
          if (clonedTarget === undefined) {
            throw new Error('isolated lazy schema target is unavailable');
          }
          return clonedTarget;
        },
        writable: true,
      });
    }

    const cloned = z.core.clone(original, clonedDefinition, { parent: false });
    schemas.set(original, cloned);
    cloning.delete(original);
    return cloned as Nested;
  };

  const clonedSchema = cloneSchema(schema);
  deeplyFreezeSchemaGraph(clonedSchema);
  return Object.freeze({
    escapedProtoProperties,
    schema: clonedSchema,
  });
};

// Exported only for isolated construction tests and internal tooling. This
// helper never grants registry identity and never writes the snapshot store.
export const createIsolatedSchemaView = <Schema extends z.ZodType>(
  schema: Schema,
): Schema => cloneSchemaGraph(schema).schema;

const restoreProtoPropertyPlaceholders = (value: unknown): void => {
  if (Array.isArray(value)) {
    for (const nested of value) restoreProtoPropertyPlaceholders(nested);
    return;
  }
  if (value === null || typeof value !== 'object') return;

  const object = value as Record<string, unknown>;
  const properties = object.properties;
  if (properties !== null && typeof properties === 'object') {
    const propertyMap = properties as Record<string, unknown>;
    const descriptor = Object.getOwnPropertyDescriptor(
      propertyMap,
      PROTO_PROPERTY_PLACEHOLDER,
    );
    if (descriptor !== undefined) {
      Object.defineProperty(propertyMap, '__proto__', descriptor);
      Reflect.deleteProperty(propertyMap, PROTO_PROPERTY_PLACEHOLDER);
    }
  }
  if (Array.isArray(object.required)) {
    object.required = object.required.map((key) =>
      key === PROTO_PROPERTY_PLACEHOLDER ? '__proto__' : key,
    );
  }
  for (const nested of Object.values(object)) {
    restoreProtoPropertyPlaceholders(nested);
  }
};

export const toIsolatedContractJsonSchema = (schema: z.ZodType): unknown => {
  const isolated = cloneSchemaGraph(schema, { escapeProtoProperties: true });
  const conversionSchema = isolated.escapedProtoProperties
    ? isolated.schema
    : schema;
  const jsonSchema = contracts.toContractJsonSchema(conversionSchema);
  if (isolated.escapedProtoProperties) {
    restoreProtoPropertyPlaceholders(jsonSchema);
  }
  return jsonSchema;
};

const createSchemaRegistryView = <Schema extends z.ZodType>(
  schema: Schema,
): Schema => {
  if (schemaSnapshotOutcomes.has(schema)) return schema;
  const unsupportedPath = unsupportedJsonSchemaPath(schema);
  let outcome: SchemaSnapshotOutcome;
  try {
    outcome = Object.freeze({
      jsonSchema: freezeJsonSnapshot(toIsolatedContractJsonSchema(schema)),
      ...(unsupportedPath === undefined ? {} : { unsupportedPath }),
    });
  } catch (error) {
    outcome = Object.freeze({
      conversionError: error instanceof Error ? error.message : String(error),
      ...(unsupportedPath === undefined ? {} : { unsupportedPath }),
    });
  }
  const view = cloneSchemaGraph(schema).schema;
  schemaSnapshotOutcomes.set(view, outcome);
  return view;
};

export const getSchemaSnapshotOutcome = <Schema extends z.ZodType>(
  schema: Schema,
): SchemaSnapshotOutcome | undefined => schemaSnapshotOutcomes.get(schema);

const deepFreeze = <Value>(value: Value): Frozen<Value> => {
  if (value === null || typeof value !== 'object') {
    return value as Frozen<Value>;
  }
  if (value instanceof z.ZodType) {
    return createSchemaRegistryView(value) as Frozen<Value>;
  }

  const frozenEntries = Object.entries(value).map(([key, nested]) => [
    key,
    deepFreeze(nested),
  ]);
  return Object.freeze(Object.fromEntries(frozenEntries)) as Frozen<Value>;
};

export const schemaRegistry: SchemaRegistry = deepFreeze({
  ApiError: contracts.apiErrorSchema,
  ApiErrorPayload: contracts.apiErrorPayloadSchema,
  ApplyCheckpointBody: contracts.applyCheckpointBodySchema,
  ApprovalDecision: contracts.approvalDecisionSchema,
  ApprovalDecisionBody: contracts.approvalDecisionBodySchema,
  ApprovalDecisionPath: contracts.approvalDecisionPathSchema,
  ApprovalDecisionView: contracts.approvalDecisionViewSchema,
  ApprovalId: contracts.approvalIdSchema,
  ApprovalKind: contracts.approvalKindSchema,
  ApprovalStatus: contracts.approvalStatusSchema,
  ApprovalView: contracts.approvalViewSchema,
  ArtifactId: contracts.artifactIdSchema,
  ArtifactReference: contracts.artifactReferenceSchema,
  ArtifactReferencesInputContent:
    contracts.artifactReferencesInputContentSchema,
  AssistantStreamBuffer: contracts.assistantStreamBufferSchema,
  AssistantTranscriptPayload: contracts.assistantTranscriptPayloadSchema,
  AuthenticatedPrincipal: contracts.authenticatedPrincipalSchema,
  AuthenticatedPrincipalKind: contracts.authenticatedPrincipalKindSchema,
  CanonicalNonBlankString: contracts.canonicalNonBlankStringSchema,
  CheckpointId: contracts.checkpointIdSchema,
  CheckpointPage: contracts.checkpointPageSchema,
  CheckpointPath: contracts.checkpointPathSchema,
  CheckpointSummary: contracts.checkpointSummarySchema,
  CommandId: contracts.commandIdSchema,
  CompletedAssistantTranscriptPayload:
    contracts.completedAssistantTranscriptPayloadSchema,
  ConfigChangeBody: contracts.configChangeBodySchema,
  ConfigPatch: contracts.configPatchSchema,
  ConfigRevision: contracts.configRevisionSchema,
  ConfigRevisionResult: contracts.configRevisionResultSchema,
  ContextBoundaryId: contracts.contextBoundaryIdSchema,
  CreateSubmissionBody: contracts.createSubmissionBodySchema,
  CreateThreadBody: contracts.createThreadBodySchema,
  CredentialRef: contracts.credentialRefSchema,
  CredentialRefId: contracts.credentialRefIdSchema,
  CredentialRevokedEventPayload: contracts.credentialRevokedEventPayloadSchema,
  DaemonDiscovery: contracts.daemonDiscoverySchema,
  DaemonEndpoint: contracts.daemonEndpointSchema,
  DaemonInstanceId: contracts.daemonInstanceIdSchema,
  DurableBasis: contracts.durableBasisSchema,
  DurableCursor: contracts.durableCursorSchema,
  EffectiveQueueDispatchState: contracts.effectiveQueueDispatchStateSchema,
  EmptyQuery: contracts.emptyQuerySchema,
  ErrorCode: contracts.errorCodeSchema,
  ErrorHttpMapping: contracts.errorHttpMappingSchema,
  EventAttachAcceptedResponse: contracts.eventAttachAcceptedResponseSchema,
  EventAttachParams: contracts.eventAttachParamsSchema,
  EventAttachQuery: contracts.eventAttachQuerySchema,
  EventAttachResetResponse: contracts.eventAttachResetResponseSchema,
  EventAttachResponse: contracts.eventAttachResponseSchema,
  EventBase: contracts.eventBaseSchema,
  EventId: contracts.eventIdSchema,
  ForkBoundary: contracts.forkBoundarySchema,
  ForkThreadBody: contracts.forkThreadBodySchema,
  HealthResponse: contracts.healthResponseSchema,
  IncarnationId: contracts.incarnationIdSchema,
  InputContent: contracts.inputContentSchema,
  InputItemId: contracts.inputItemIdSchema,
  InputItemView: contracts.inputItemViewSchema,
  InputRole: contracts.inputRoleSchema,
  InputSource: contracts.inputSourceSchema,
  InputTranscriptPayload: contracts.inputTranscriptPayloadSchema,
  InterruptedAssistantTranscriptPayload:
    contracts.interruptedAssistantTranscriptPayloadSchema,
  JsonObject: contracts.jsonObjectSchema,
  JsonValue: contracts.jsonValueSchema,
  KnownDurableEventEnvelope: contracts.knownDurableEventEnvelopeSchema,
  KnownDurableEventPayload: contracts.knownDurableEventPayloadSchema,
  KnownThreadStreamFrame: contracts.knownThreadStreamFrameSchema,
  KnownTransientEventEnvelope: contracts.knownTransientEventEnvelopeSchema,
  KnownTransientEventPayload: contracts.knownTransientEventPayloadSchema,
  LineageId: contracts.lineageIdSchema,
  NetworkPolicy: contracts.networkPolicySchema,
  NewInputItem: contracts.newInputItemSchema,
  OperationCancelledEventPayload:
    contracts.operationCancelledEventPayloadSchema,
  OperationCompletedEventPayload:
    contracts.operationCompletedEventPayloadSchema,
  OperationCompletionEventKind: contracts.operationCompletionEventKindSchema,
  OperationFailedEventPayload: contracts.operationFailedEventPayloadSchema,
  OperationId: contracts.operationIdSchema,
  OperationKind: contracts.operationKindSchema,
  OperationListQuery: contracts.operationListQuerySchema,
  OperationPage: contracts.operationPageSchema,
  OperationPath: contracts.operationPathSchema,
  OperationProgress: contracts.operationProgressSchema,
  OperationStatus: contracts.operationStatusSchema,
  OperationTerminalEventPayload: contracts.operationTerminalEventPayloadSchema,
  OperationTranscriptPayload: contracts.operationTranscriptPayloadSchema,
  OperationView: contracts.operationViewSchema,
  PageCursor: contracts.pageCursorSchema,
  PageInfo: contracts.pageInfoSchema,
  PaginationQuery: contracts.paginationQuerySchema,
  ParseThreadStreamFrameResult: contracts.parseThreadStreamFrameResultSchema,
  PatchQueueItemBody: contracts.patchQueueItemBodySchema,
  PatchQueueItemResult: contracts.patchQueueItemResultSchema,
  PatchThreadBody: contracts.patchThreadBodySchema,
  PlanGeneration: contracts.planGenerationSchema,
  PluginCapabilities: contracts.pluginCapabilitiesSchema,
  PluginId: contracts.pluginIdSchema,
  PolicyChangeBody: contracts.policyChangeBodySchema,
  PolicyPatch: contracts.policyPatchSchema,
  PolicyRevision: contracts.policyRevisionSchema,
  PolicyRevisionResult: contracts.policyRevisionResultSchema,
  PrincipalId: contracts.principalIdSchema,
  QueueControlState: contracts.queueControlStateSchema,
  QueueItemId: contracts.queueItemIdSchema,
  QueueItemPath: contracts.queueItemPathSchema,
  QueueItemStatus: contracts.queueItemStatusSchema,
  QueueItemView: contracts.queueItemViewSchema,
  QueueMutationBody: contracts.queueMutationBodySchema,
  QueueRevisionResult: contracts.queueRevisionResultSchema,
  QueueView: contracts.queueViewSchema,
  ReasoningEffort: contracts.reasoningEffortSchema,
  ReorderQueueBody: contracts.reorderQueueBodySchema,
  ResetId: contracts.resetIdSchema,
  Revision: contracts.revisionSchema,
  RunId: contracts.runIdSchema,
  RunKind: contracts.runKindSchema,
  RunPage: contracts.runPageSchema,
  RunPath: contracts.runPathSchema,
  RunStatus: contracts.runStatusSchema,
  RunTerminalReason: contracts.runTerminalReasonSchema,
  RunView: contracts.runViewSchema,
  SandboxPolicy: contracts.sandboxPolicySchema,
  SnapshotReset: contracts.snapshotResetSchema,
  SnapshotResetKind: contracts.snapshotResetKindSchema,
  SnapshotResetReason: contracts.snapshotResetReasonSchema,
  SteerRunBody: contracts.steerRunBodySchema,
  SteerStalePolicy: contracts.steerStalePolicySchema,
  StopRunBody: contracts.stopRunBodySchema,
  StreamBasis: contracts.streamBasisSchema,
  StreamCursor: contracts.streamCursorSchema,
  StreamInterruptionReason: contracts.streamInterruptionReasonSchema,
  StreamStateSnapshot: contracts.streamStateSnapshotSchema,
  StreamStateStatus: contracts.streamStateStatusSchema,
  StreamingAssistantTranscriptPayload:
    contracts.streamingAssistantTranscriptPayloadSchema,
  StructuredInputContent: contracts.structuredInputContentSchema,
  SubmissionDisposition: contracts.submissionDispositionSchema,
  SubmissionResult: contracts.submissionResultSchema,
  SystemTranscriptPayload: contracts.systemTranscriptPayloadSchema,
  TextInputContent: contracts.textInputContentSchema,
  ThreadId: contracts.threadIdSchema,
  ThreadLifecycle: contracts.threadLifecycleSchema,
  ThreadLifecycleBody: contracts.threadLifecycleBodySchema,
  ThreadMetadataPatch: contracts.threadMetadataPatchSchema,
  ThreadPage: contracts.threadPageSchema,
  ThreadPath: contracts.threadPathSchema,
  ThreadRuntimeStatus: contracts.threadRuntimeStatusSchema,
  ThreadSnapshot: contracts.threadSnapshotSchema,
  ThreadStreamFrame: contracts.threadStreamFrameSchema,
  ThreadView: contracts.threadViewSchema,
  Timestamp: contracts.timestampSchema,
  TokenRef: contracts.tokenRefSchema,
  ToolExecutionId: contracts.toolExecutionIdSchema,
  ToolExecutionState: contracts.toolExecutionStateSchema,
  ToolExecutionSummary: contracts.toolExecutionSummarySchema,
  ToolStreamBuffer: contracts.toolStreamBufferSchema,
  ToolTranscriptPayload: contracts.toolTranscriptPayloadSchema,
  TranscriptItemId: contracts.transcriptItemIdSchema,
  TranscriptItemKind: contracts.transcriptItemKindSchema,
  TranscriptItemView: contracts.transcriptItemViewSchema,
  TranscriptStatus: contracts.transcriptStatusSchema,
  UndefinedResult: contracts.undefinedResultSchema,
  UnknownDurableEventEnvelope: contracts.unknownDurableEventEnvelopeSchema,
  UnknownEventEnvelope: contracts.unknownEventEnvelopeSchema,
  UnknownTransientEventEnvelope: contracts.unknownTransientEventEnvelopeSchema,
  WorkspaceBinding: contracts.workspaceBindingSchema,
  WorkspaceId: contracts.workspaceIdSchema,
  WorkspaceTrust: contracts.workspaceTrustSchema,
} as const);

export const httpRegistry: HttpRegistry = deepFreeze({
  'approval.decide': httpContractRegistry['approval.decide'],
  'checkpoint.apply': httpContractRegistry['checkpoint.apply'],
  'checkpoint.list': httpContractRegistry['checkpoint.list'],
  'config.change': httpContractRegistry['config.change'],
  'event.attach': httpContractRegistry['event.attach'],
  'operation.get': httpContractRegistry['operation.get'],
  'operation.list': httpContractRegistry['operation.list'],
  'policy.change': httpContractRegistry['policy.change'],
  'queue.get': httpContractRegistry['queue.get'],
  'queue.item.delete': httpContractRegistry['queue.item.delete'],
  'queue.item.patch': httpContractRegistry['queue.item.patch'],
  'queue.pause': httpContractRegistry['queue.pause'],
  'queue.reorder': httpContractRegistry['queue.reorder'],
  'queue.resume': httpContractRegistry['queue.resume'],
  'run.get': httpContractRegistry['run.get'],
  'run.list': httpContractRegistry['run.list'],
  'run.steer': httpContractRegistry['run.steer'],
  'run.stop': httpContractRegistry['run.stop'],
  'snapshot.get': httpContractRegistry['snapshot.get'],
  'submission.create': httpContractRegistry['submission.create'],
  'thread.archive': httpContractRegistry['thread.archive'],
  'thread.create': httpContractRegistry['thread.create'],
  'thread.delete': httpContractRegistry['thread.delete'],
  'thread.fork': httpContractRegistry['thread.fork'],
  'thread.get': httpContractRegistry['thread.get'],
  'thread.list': httpContractRegistry['thread.list'],
  'thread.patch': httpContractRegistry['thread.patch'],
  'thread.resume': httpContractRegistry['thread.resume'],
  'thread.unarchive': httpContractRegistry['thread.unarchive'],
  'thread.undelete': httpContractRegistry['thread.undelete'],
} as const);

export const eventSchemaRegistry: EventSchemaRegistry = deepFreeze({
  KnownDurableEventEnvelope: schemaRegistry.KnownDurableEventEnvelope,
  KnownThreadStreamFrame: schemaRegistry.KnownThreadStreamFrame,
  KnownTransientEventEnvelope: schemaRegistry.KnownTransientEventEnvelope,
  SnapshotReset: schemaRegistry.SnapshotReset,
  ThreadStreamFrame: schemaRegistry.ThreadStreamFrame,
  UnknownDurableEventEnvelope: schemaRegistry.UnknownDurableEventEnvelope,
  UnknownEventEnvelope: schemaRegistry.UnknownEventEnvelope,
  UnknownTransientEventEnvelope: schemaRegistry.UnknownTransientEventEnvelope,
} as const);

export const contractRegistry: ContractRegistry = Object.freeze({
  events: eventSchemaRegistry,
  http: httpRegistry,
  schemas: schemaRegistry,
} as const);
