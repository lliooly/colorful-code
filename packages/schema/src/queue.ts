import { z } from 'zod';

import {
  jsonValueSchema,
  revisionSchema,
  strictObjectSchema,
  timestampSchema,
} from './common.js';
import {
  effectiveQueueDispatchStateSchema,
  operationStatusSchema,
  queueControlStateSchema,
  queueItemStatusSchema,
  transcriptItemKindSchema,
  transcriptStatusSchema,
} from './enums.js';
import {
  operationIdSchema,
  queueItemIdSchema,
  runIdSchema,
  threadIdSchema,
  toolExecutionIdSchema,
  transcriptItemIdSchema,
} from './ids.js';
import { inputItemViewSchema } from './thread.js';

export const queueItemViewSchema = strictObjectSchema({
  queueItemId: queueItemIdSchema,
  threadId: threadIdSchema,
  input: inputItemViewSchema,
  status: queueItemStatusSchema,
  sourceRunId: runIdSchema.nullable(),
  resultingRunId: runIdSchema.nullable(),
  revision: revisionSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});
export type QueueItemView = z.infer<typeof queueItemViewSchema>;

const queueViewBaseShape = {
  threadId: threadIdSchema,
  items: z.array(queueItemViewSchema),
  revision: revisionSchema,
};

export const queueViewSchema = z.union([
  strictObjectSchema({
    ...queueViewBaseShape,
    controlState: queueControlStateSchema,
    blockedByIndeterminate: z.literal(true),
    effectiveState: z.literal(
      effectiveQueueDispatchStateSchema.enum.blockedByIndeterminate,
    ),
  }),
  ...queueControlStateSchema.options.map((controlState) =>
    strictObjectSchema({
      ...queueViewBaseShape,
      controlState: z.literal(controlState),
      blockedByIndeterminate: z.literal(false),
      effectiveState: z.literal(controlState),
    }),
  ),
]);
export type QueueView = z.infer<typeof queueViewSchema>;

export const inputTranscriptPayloadSchema = strictObjectSchema({
  input: inputItemViewSchema,
});
export type InputTranscriptPayload = z.infer<
  typeof inputTranscriptPayloadSchema
>;

export const streamingAssistantTranscriptPayloadSchema = strictObjectSchema({
  status: z.literal(transcriptStatusSchema.enum.streaming),
  content: jsonValueSchema,
  finishReason: z.null(),
});
export type StreamingAssistantTranscriptPayload = z.infer<
  typeof streamingAssistantTranscriptPayloadSchema
>;

const terminalAssistantPayloadShape = {
  content: jsonValueSchema,
  finishReason: z.string().trim().min(1),
};

export const interruptedAssistantTranscriptPayloadSchema = strictObjectSchema({
  status: z.literal(transcriptStatusSchema.enum.interrupted),
  ...terminalAssistantPayloadShape,
});
export type InterruptedAssistantTranscriptPayload = z.infer<
  typeof interruptedAssistantTranscriptPayloadSchema
>;

export const completedAssistantTranscriptPayloadSchema = strictObjectSchema({
  status: z.literal(transcriptStatusSchema.enum.completed),
  ...terminalAssistantPayloadShape,
});
export type CompletedAssistantTranscriptPayload = z.infer<
  typeof completedAssistantTranscriptPayloadSchema
>;

export const assistantTranscriptPayloadSchema = z.discriminatedUnion('status', [
  streamingAssistantTranscriptPayloadSchema,
  interruptedAssistantTranscriptPayloadSchema,
  completedAssistantTranscriptPayloadSchema,
]);
export type AssistantTranscriptPayload = z.infer<
  typeof assistantTranscriptPayloadSchema
>;

export const toolTranscriptPayloadSchema = strictObjectSchema({
  toolExecutionId: toolExecutionIdSchema,
  content: jsonValueSchema,
});
export type ToolTranscriptPayload = z.infer<typeof toolTranscriptPayloadSchema>;

export const systemTranscriptPayloadSchema = strictObjectSchema({
  content: jsonValueSchema,
});
export type SystemTranscriptPayload = z.infer<
  typeof systemTranscriptPayloadSchema
>;

export const operationTranscriptPayloadSchema = strictObjectSchema({
  operationId: operationIdSchema,
  status: operationStatusSchema,
  content: jsonValueSchema,
});
export type OperationTranscriptPayload = z.infer<
  typeof operationTranscriptPayloadSchema
>;

const transcriptItemBaseShape = {
  transcriptItemId: transcriptItemIdSchema,
  threadId: threadIdSchema,
  runId: runIdSchema.nullable(),
  createdAt: timestampSchema,
};

export const transcriptItemViewSchema = z.discriminatedUnion('kind', [
  strictObjectSchema({
    ...transcriptItemBaseShape,
    kind: z.literal(transcriptItemKindSchema.enum.input),
    payload: inputTranscriptPayloadSchema,
  }),
  strictObjectSchema({
    ...transcriptItemBaseShape,
    kind: z.literal(transcriptItemKindSchema.enum.assistant),
    payload: assistantTranscriptPayloadSchema,
  }),
  strictObjectSchema({
    ...transcriptItemBaseShape,
    kind: z.literal(transcriptItemKindSchema.enum.tool),
    payload: toolTranscriptPayloadSchema,
  }),
  strictObjectSchema({
    ...transcriptItemBaseShape,
    kind: z.literal(transcriptItemKindSchema.enum.system),
    payload: systemTranscriptPayloadSchema,
  }),
  strictObjectSchema({
    ...transcriptItemBaseShape,
    kind: z.literal(transcriptItemKindSchema.enum.operation),
    payload: operationTranscriptPayloadSchema,
  }),
]);
export type TranscriptItemView = z.infer<typeof transcriptItemViewSchema>;
