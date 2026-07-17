import { z } from 'zod';

import {
  durableCursorSchema,
  jsonValueSchema,
  planGenerationSchema,
  streamCursorSchema,
  strictObjectSchema,
  timestampSchema,
} from './common.js';
import {
  eventIdSchema,
  incarnationIdSchema,
  operationIdSchema,
  runIdSchema,
  threadIdSchema,
  toolExecutionIdSchema,
} from './ids.js';
import {
  operationProgressSchema,
  operationTerminalEventPayloadSchema,
  approvalViewSchema,
  toolExecutionSummarySchema,
} from './operations.js';
import { queueViewSchema } from './queue.js';
import { runViewSchema } from './run.js';
import { threadViewSchema } from './thread.js';

const MAX_DELTA_CHUNK_LENGTH = 65_536;

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
});
export type StreamBasis = z.infer<typeof streamBasisSchema>;

export const createEventPayloadSchema = <
  const Kind extends string,
  PayloadSchema extends z.ZodType,
>(
  kind: Kind,
  payloadSchema: PayloadSchema,
) =>
  strictObjectSchema({
    kind: z.literal(kind),
    payload: payloadSchema,
  });

type EventPayloadShape = {
  kind: z.ZodLiteral<string>;
  payload: z.ZodType;
};

export const createDurableEventEnvelopeSchema = <
  Shape extends EventPayloadShape,
>(
  eventPayloadSchema: z.ZodObject<Shape>,
) =>
  strictObjectSchema({
    ...eventBaseShape,
    kind: eventPayloadSchema.shape.kind,
    payload: eventPayloadSchema.shape.payload,
    durability: z.literal('durable'),
    durableSequence: durableCursorSchema,
    streamBasis: streamBasisSchema.optional(),
  });

export const createTransientEventEnvelopeSchema = <
  Shape extends EventPayloadShape,
>(
  eventPayloadSchema: z.ZodObject<Shape>,
) =>
  strictObjectSchema({
    ...eventBaseShape,
    kind: eventPayloadSchema.shape.kind,
    payload: eventPayloadSchema.shape.payload,
    durability: z.literal('transient'),
    incarnationId: incarnationIdSchema,
    streamSequence: streamCursorSchema,
    durableBasis: durableCursorSchema,
  });

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

const [
  completedOperationPayloadSchema,
  failedOperationPayloadSchema,
  cancelledOperationPayloadSchema,
] = operationTerminalEventPayloadSchema.options;

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
