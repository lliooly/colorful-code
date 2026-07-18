import { z } from 'zod';

import {
  createBoundedJsonValueSchema,
  durableCursorSchema,
  jsonValueSchema,
  type JsonValue,
  planGenerationSchema,
  streamCursorSchema,
  strictObjectSchema,
  timestampSchema,
} from './common.js';
import { apiErrorPayloadSchema } from './errors.js';
import {
  eventIdSchema,
  incarnationIdSchema,
  operationIdSchema,
  runIdSchema,
  threadIdSchema,
  toolExecutionIdSchema,
} from './ids.js';
import {
  operationCancelledEventPayloadSchema as cancelledOperationPayloadSchema,
  operationCompletedEventPayloadSchema as completedOperationPayloadSchema,
  operationFailedEventPayloadSchema as failedOperationPayloadSchema,
  operationProgressSchema,
  approvalViewSchema,
  toolExecutionSummarySchema,
} from './operations.js';
import { queueViewSchema } from './queue.js';
import { runViewSchema } from './run.js';
import { snapshotResetKindSchema, snapshotResetSchema } from './snapshot.js';
import {
  MAX_THREAD_STREAM_FRAME_SERIALIZED_LENGTH,
  MAX_THREAD_STREAM_FRAME_TOKEN_COUNT,
} from './stream-limits.js';
import { threadViewSchema } from './thread.js';

const MAX_DELTA_CHUNK_LENGTH = 65_536;

// Transports must still enforce their own byte limit. These parser-side length
// and token budgets provide defense in depth before frame-specific routing.
const threadStreamFrameInputSchema = createBoundedJsonValueSchema(
  MAX_THREAD_STREAM_FRAME_SERIALIZED_LENGTH,
  MAX_THREAD_STREAM_FRAME_TOKEN_COUNT,
);

const eventBaseShape = {
  eventId: eventIdSchema,
  threadId: threadIdSchema,
  kind: z.string().trim().min(1),
  critical: z.boolean(),
  occurredAt: timestampSchema,
  runId: runIdSchema.optional(),
  planGeneration: planGenerationSchema.optional(),
  payload: jsonValueSchema,
};

export const eventBaseSchema = strictObjectSchema(eventBaseShape);
export type EventBase = z.infer<typeof eventBaseSchema>;

export const streamBasisSchema = strictObjectSchema({
  incarnationId: incarnationIdSchema,
  streamSequence: streamCursorSchema,
}).describe(
  'streamBasis references a pre-existing high-watermark in a specific incarnation stream space. It must not be compared with durableSequence or any durable cursor; it is a causal basis, not a third cursor.',
);
export type StreamBasis = z.infer<typeof streamBasisSchema>;

const durableBasisSchema = durableCursorSchema.describe(
  'durableBasis references a pre-existing high-watermark in the durable cursor space. It must not be compared with streamSequence or any incarnation stream cursor; it is a causal basis, not a third cursor.',
);

const assertJsonSchemaCompatible = (payloadSchema: z.ZodType) => {
  try {
    z.toJSONSchema(payloadSchema);
  } catch (error) {
    throw new TypeError('Event payload schema must describe JSON wire values', {
      cause: error,
    });
  }
};

type JsonWireOutput<Value> = 0 extends 1 & Value
  ? JsonValue
  : unknown extends Value
    ? JsonValue
    : Extract<Value, JsonValue>;

const invalidJsonWirePayload = Symbol('invalidJsonWirePayload');

type JsonWirePayloadSchema<PayloadSchema extends z.ZodType> = z.ZodType<
  JsonWireOutput<z.output<PayloadSchema>>,
  z.input<PayloadSchema>
>;

const createJsonWirePayloadSchema = <PayloadSchema extends z.ZodType>(
  payloadSchema: PayloadSchema,
): JsonWirePayloadSchema<PayloadSchema> => {
  assertJsonSchemaCompatible(payloadSchema);
  return payloadSchema
    .nonoptional()
    .overwrite((value) => {
      const result = jsonValueSchema.safeParse(value);
      return (
        result.success ? result.data : invalidJsonWirePayload
      ) as typeof value;
    })
    .superRefine((value, context) => {
      if ((value as unknown) === invalidJsonWirePayload) {
        context.addIssue({
          code: 'custom',
          message: 'Expected a JSON wire value',
        });
      }
    }) as z.ZodType<
    JsonWireOutput<z.output<PayloadSchema>>,
    z.input<PayloadSchema>
  >;
};

export const createEventPayloadSchema = <
  const Kind extends string,
  PayloadSchema extends z.ZodType,
>(
  kind: Kind,
  payloadSchema: PayloadSchema,
) => {
  if (kind.trim().length === 0) {
    throw new TypeError('Event kind must be a non-empty string');
  }

  return strictObjectSchema({
    kind: z.literal(kind),
    payload: createJsonWirePayloadSchema(payloadSchema),
  });
};

type EventPayloadShape = {
  kind: z.ZodLiteral<string>;
  payload: z.ZodType;
};

type DurableEventEnvelopeShape<Shape extends EventPayloadShape> = Omit<
  typeof eventBaseShape,
  'kind' | 'payload'
> & {
  kind: Shape['kind'];
  payload: JsonWirePayloadSchema<Shape['payload']>;
  durability: z.ZodLiteral<'durable'>;
  durableSequence: typeof durableCursorSchema;
  streamBasis: z.ZodOptional<typeof streamBasisSchema>;
};

type TransientEventEnvelopeShape<Shape extends EventPayloadShape> = Omit<
  typeof eventBaseShape,
  'kind' | 'payload'
> & {
  kind: Shape['kind'];
  payload: JsonWirePayloadSchema<Shape['payload']>;
  durability: z.ZodLiteral<'transient'>;
  incarnationId: typeof incarnationIdSchema;
  streamSequence: typeof streamCursorSchema;
  durableBasis: typeof durableBasisSchema;
};

const assertSingleEventKind = (kindSchema: z.ZodLiteral<string>) => {
  const kinds = [...kindSchema.values];
  if (
    kinds.length !== 1 ||
    typeof kinds[0] !== 'string' ||
    kinds[0].trim().length === 0
  ) {
    throw new TypeError('Event kind must be one non-empty string literal');
  }
};

export const createDurableEventEnvelopeSchema = <
  const Shape extends EventPayloadShape,
>(
  eventPayloadSchema: z.ZodObject<Shape>,
) => {
  assertSingleEventKind(eventPayloadSchema.shape.kind);
  const payloadSchema = eventPayloadSchema.shape.payload as Shape['payload'];
  const shape: DurableEventEnvelopeShape<Shape> = {
    ...eventBaseShape,
    kind: eventPayloadSchema.shape.kind,
    payload: createJsonWirePayloadSchema(payloadSchema),
    durability: z.literal('durable'),
    durableSequence: durableCursorSchema,
    streamBasis: streamBasisSchema.optional(),
  };
  return strictObjectSchema(shape);
};

export const createTransientEventEnvelopeSchema = <
  const Shape extends EventPayloadShape,
>(
  eventPayloadSchema: z.ZodObject<Shape>,
) => {
  assertSingleEventKind(eventPayloadSchema.shape.kind);
  const payloadSchema = eventPayloadSchema.shape.payload as Shape['payload'];
  const shape: TransientEventEnvelopeShape<Shape> = {
    ...eventBaseShape,
    kind: eventPayloadSchema.shape.kind,
    payload: createJsonWirePayloadSchema(payloadSchema),
    durability: z.literal('transient'),
    incarnationId: incarnationIdSchema,
    streamSequence: streamCursorSchema,
    durableBasis: durableBasisSchema,
  };
  return strictObjectSchema(shape);
};

const threadUpdatedEventPayloadSchema = createEventPayloadSchema(
  'thread.updated',
  threadViewSchema,
);
const threadLifecycleChangedEventPayloadSchema = createEventPayloadSchema(
  'thread.lifecycleChanged',
  threadViewSchema,
);
const runStatusChangedEventPayloadSchema = createEventPayloadSchema(
  'run.statusChanged',
  runViewSchema,
);
const queueChangedEventPayloadSchema = createEventPayloadSchema(
  'queue.changed',
  queueViewSchema,
);

const operationCompletedEventPayloadSchema = createEventPayloadSchema(
  'operation.completed',
  completedOperationPayloadSchema,
);
const operationFailedEventPayloadSchema = createEventPayloadSchema(
  'operation.failed',
  failedOperationPayloadSchema,
);
const operationCancelledEventPayloadSchema = createEventPayloadSchema(
  'operation.cancelled',
  cancelledOperationPayloadSchema,
);

const approvalRequestedEventPayloadSchema = createEventPayloadSchema(
  'approval.requested',
  approvalViewSchema.safeExtend({ status: z.literal('pending') }),
);
const approvalResolvedEventPayloadSchema = createEventPayloadSchema(
  'approval.resolved',
  approvalViewSchema.safeExtend({
    status: z.enum(['approved', 'denied', 'cancelled']),
  }),
);
const approvalExpiredEventPayloadSchema = createEventPayloadSchema(
  'approval.expired',
  approvalViewSchema.safeExtend({ status: z.literal('expired') }),
);
const toolTerminalEventPayloadSchema = createEventPayloadSchema(
  'tool.terminal',
  toolExecutionSummarySchema.safeExtend({
    state: z.enum(['completed', 'failed', 'cancelled', 'indeterminate']),
  }),
);

export const knownDurableEventPayloadSchema = z.discriminatedUnion('kind', [
  threadUpdatedEventPayloadSchema,
  threadLifecycleChangedEventPayloadSchema,
  runStatusChangedEventPayloadSchema,
  queueChangedEventPayloadSchema,
  operationCompletedEventPayloadSchema,
  operationFailedEventPayloadSchema,
  operationCancelledEventPayloadSchema,
  approvalRequestedEventPayloadSchema,
  approvalResolvedEventPayloadSchema,
  approvalExpiredEventPayloadSchema,
  toolTerminalEventPayloadSchema,
]);
export type KnownDurableEventPayload = z.infer<
  typeof knownDurableEventPayloadSchema
>;

export const knownDurableEventEnvelopeSchema = z.discriminatedUnion('kind', [
  createDurableEventEnvelopeSchema(threadUpdatedEventPayloadSchema),
  createDurableEventEnvelopeSchema(threadLifecycleChangedEventPayloadSchema),
  createDurableEventEnvelopeSchema(runStatusChangedEventPayloadSchema),
  createDurableEventEnvelopeSchema(queueChangedEventPayloadSchema),
  createDurableEventEnvelopeSchema(operationCompletedEventPayloadSchema),
  createDurableEventEnvelopeSchema(operationFailedEventPayloadSchema),
  createDurableEventEnvelopeSchema(operationCancelledEventPayloadSchema),
  createDurableEventEnvelopeSchema(approvalRequestedEventPayloadSchema),
  createDurableEventEnvelopeSchema(approvalResolvedEventPayloadSchema),
  createDurableEventEnvelopeSchema(approvalExpiredEventPayloadSchema),
  createDurableEventEnvelopeSchema(toolTerminalEventPayloadSchema),
]);
export type KnownDurableEventEnvelope = z.infer<
  typeof knownDurableEventEnvelopeSchema
>;

const deltaChunkSchema = z.string().min(1).max(MAX_DELTA_CHUNK_LENGTH);
const assistantDeltaPayloadSchema = strictObjectSchema({
  chunk: deltaChunkSchema,
});
const toolDeltaPayloadSchema = strictObjectSchema({
  toolExecutionId: toolExecutionIdSchema,
  chunk: deltaChunkSchema,
});
const operationProgressDeltaPayloadSchema = strictObjectSchema({
  operationId: operationIdSchema,
  progress: operationProgressSchema,
});

const assistantTextDeltaEventPayloadSchema = createEventPayloadSchema(
  'assistant.textDelta',
  assistantDeltaPayloadSchema,
);
const assistantReasoningDeltaEventPayloadSchema = createEventPayloadSchema(
  'assistant.reasoningDelta',
  assistantDeltaPayloadSchema,
);
const toolStdoutDeltaEventPayloadSchema = createEventPayloadSchema(
  'tool.stdoutDelta',
  toolDeltaPayloadSchema,
);
const toolStderrDeltaEventPayloadSchema = createEventPayloadSchema(
  'tool.stderrDelta',
  toolDeltaPayloadSchema,
);
const operationProgressDeltaEventPayloadSchema = createEventPayloadSchema(
  'operation.progressDelta',
  operationProgressDeltaPayloadSchema,
);

export const knownTransientEventPayloadSchema = z.discriminatedUnion('kind', [
  assistantTextDeltaEventPayloadSchema,
  assistantReasoningDeltaEventPayloadSchema,
  toolStdoutDeltaEventPayloadSchema,
  toolStderrDeltaEventPayloadSchema,
  operationProgressDeltaEventPayloadSchema,
]);
export type KnownTransientEventPayload = z.infer<
  typeof knownTransientEventPayloadSchema
>;

export const knownTransientEventEnvelopeSchema = z.discriminatedUnion('kind', [
  createTransientEventEnvelopeSchema(assistantTextDeltaEventPayloadSchema),
  createTransientEventEnvelopeSchema(assistantReasoningDeltaEventPayloadSchema),
  createTransientEventEnvelopeSchema(toolStdoutDeltaEventPayloadSchema),
  createTransientEventEnvelopeSchema(toolStderrDeltaEventPayloadSchema),
  createTransientEventEnvelopeSchema(operationProgressDeltaEventPayloadSchema),
]);
export type KnownTransientEventEnvelope = z.infer<
  typeof knownTransientEventEnvelopeSchema
>;

const reservedEventKinds = Object.freeze([
  snapshotResetKindSchema.value,
  'thread.updated',
  'thread.lifecycleChanged',
  'run.statusChanged',
  'queue.changed',
  'operation.completed',
  'operation.failed',
  'operation.cancelled',
  'approval.requested',
  'approval.resolved',
  'approval.expired',
  'tool.terminal',
  'assistant.textDelta',
  'assistant.reasoningDelta',
  'tool.stdoutDelta',
  'tool.stderrDelta',
  'operation.progressDelta',
] as const);

const escapeRegularExpression = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const reservedEventKindPattern = reservedEventKinds
  .map(escapeRegularExpression)
  .join('|');

const unknownEventKindSchema = z
  .string()
  .regex(
    new RegExp(
      `^(?!(?:${reservedEventKindPattern})$)(?!\\s)(?![\\s\\S]*\\s$)[\\s\\S]+$`,
    ),
    'Expected a non-blank unknown event kind without edge whitespace',
  );

export const unknownDurableEventEnvelopeSchema = strictObjectSchema({
  ...eventBaseShape,
  kind: unknownEventKindSchema,
  durability: z.literal('durable'),
  durableSequence: durableCursorSchema,
  streamBasis: streamBasisSchema.optional(),
});
export type UnknownDurableEventEnvelope = z.infer<
  typeof unknownDurableEventEnvelopeSchema
>;

export const unknownTransientEventEnvelopeSchema = strictObjectSchema({
  ...eventBaseShape,
  kind: unknownEventKindSchema,
  durability: z.literal('transient'),
  incarnationId: incarnationIdSchema,
  streamSequence: streamCursorSchema,
  durableBasis: durableBasisSchema,
});
export type UnknownTransientEventEnvelope = z.infer<
  typeof unknownTransientEventEnvelopeSchema
>;

export const unknownEventEnvelopeSchema = z.discriminatedUnion('durability', [
  unknownDurableEventEnvelopeSchema,
  unknownTransientEventEnvelopeSchema,
]);
export type UnknownEventEnvelope = z.infer<typeof unknownEventEnvelopeSchema>;

export const knownThreadStreamFrameSchema = z.union([
  snapshotResetSchema,
  knownDurableEventEnvelopeSchema,
  knownTransientEventEnvelopeSchema,
]);
export type KnownThreadStreamFrame = z.infer<
  typeof knownThreadStreamFrameSchema
>;

export const threadStreamFrameSchema = z.union([
  knownThreadStreamFrameSchema,
  unknownEventEnvelopeSchema,
]);
export type ThreadStreamFrame = z.infer<typeof threadStreamFrameSchema>;

const unknownNonCriticalEventEnvelopeSchema = z.discriminatedUnion(
  'durability',
  [
    unknownDurableEventEnvelopeSchema.safeExtend({
      critical: z.literal(false),
    }),
    unknownTransientEventEnvelopeSchema.safeExtend({
      critical: z.literal(false),
    }),
  ],
);

export const parseThreadStreamFrameResultSchema = z.discriminatedUnion(
  'outcome',
  [
    strictObjectSchema({
      outcome: z.literal('known'),
      frame: knownThreadStreamFrameSchema,
    }),
    strictObjectSchema({
      outcome: z.literal('unknownNonCritical'),
      frame: unknownNonCriticalEventEnvelopeSchema,
    }),
    strictObjectSchema({
      outcome: z.literal('resetRequired'),
      reason: z.literal('criticalUnknownEvent'),
      eventId: eventIdSchema,
      kind: unknownEventKindSchema,
    }),
    strictObjectSchema({
      outcome: z.literal('protocolError'),
      error: apiErrorPayloadSchema,
    }),
  ],
);
export type ParseThreadStreamFrameResult = z.infer<
  typeof parseThreadStreamFrameResultSchema
>;

const protocolError = (): ParseThreadStreamFrameResult => ({
  outcome: 'protocolError',
  error: apiErrorPayloadSchema.parse({
    code: 'VALIDATION_ERROR',
    message: 'Invalid thread stream frame',
    retryable: false,
  }),
});

export const parseThreadStreamFrame = (
  input: unknown,
): ParseThreadStreamFrameResult => {
  try {
    const normalized = threadStreamFrameInputSchema.safeParse(input);
    if (!normalized.success) return protocolError();

    const reset = snapshotResetSchema.safeParse(normalized.data);
    if (reset.success) return { outcome: 'known', frame: reset.data };

    const knownDurable = knownDurableEventEnvelopeSchema.safeParse(
      normalized.data,
    );
    if (knownDurable.success) {
      return { outcome: 'known', frame: knownDurable.data };
    }

    const knownTransient = knownTransientEventEnvelopeSchema.safeParse(
      normalized.data,
    );
    if (knownTransient.success) {
      return { outcome: 'known', frame: knownTransient.data };
    }

    const unknown = unknownEventEnvelopeSchema.safeParse(normalized.data);
    if (!unknown.success) return protocolError();
    if (unknown.data.critical) {
      return {
        outcome: 'resetRequired',
        reason: 'criticalUnknownEvent',
        eventId: unknown.data.eventId,
        kind: unknown.data.kind,
      };
    }

    const nonCritical = unknownNonCriticalEventEnvelopeSchema.parse(
      unknown.data,
    );
    return { outcome: 'unknownNonCritical', frame: nonCritical };
  } catch {
    return protocolError();
  }
};
