import { z } from 'zod';

import {
  durableCursorSchema,
  jsonValueSchema,
  pageSchema,
  revisionSchema,
  streamCursorSchema,
  strictObjectSchema,
} from './common.js';
import {
  streamInterruptionReasonSchema,
  streamStateStatusSchema,
} from './enums.js';
import {
  incarnationIdSchema,
  toolExecutionIdSchema,
  transcriptItemIdSchema,
} from './ids.js';
import {
  approvalViewSchema,
  operationViewSchema,
  toolExecutionSummarySchema,
} from './operations.js';
import { queueViewSchema, transcriptItemViewSchema } from './queue.js';
import { runViewSchema } from './run.js';
import { threadViewSchema } from './thread.js';

export const messageStreamBufferSchema = strictObjectSchema({
  transcriptItemId: transcriptItemIdSchema,
  text: z.string(),
});
export const toolStreamBufferSchema = strictObjectSchema({
  toolExecutionId: toolExecutionIdSchema,
  content: jsonValueSchema,
});

const streamBuffersShape = {
  messageBuffers: z.array(messageStreamBufferSchema),
  toolBuffers: z.array(toolStreamBufferSchema),
};
export const streamStateSnapshotSchema = z.discriminatedUnion('status', [
  strictObjectSchema({
    ...streamBuffersShape,
    status: z.literal(streamStateStatusSchema.enum.streaming),
    interruptionReason: z.null(),
  }),
  strictObjectSchema({
    ...streamBuffersShape,
    status: z.literal(streamStateStatusSchema.enum.completed),
    interruptionReason: z.null(),
  }),
  strictObjectSchema({
    ...streamBuffersShape,
    status: z.literal(streamStateStatusSchema.enum.interrupted),
    interruptionReason: streamInterruptionReasonSchema,
  }),
]);
export type StreamStateSnapshot = z.infer<typeof streamStateSnapshotSchema>;

const snapshotBaseShape = {
  thread: threadViewSchema,
  activeRun: runViewSchema.optional(),
  recentRuns: pageSchema(runViewSchema),
  queue: queueViewSchema,
  pendingOperations: z.array(operationViewSchema),
  pendingApprovals: z.array(approvalViewSchema),
  transcript: pageSchema(transcriptItemViewSchema),
  toolExecutions: z.array(toolExecutionSummarySchema),
  durableCursor: durableCursorSchema,
  snapshotVersion: revisionSchema,
};

export const threadSnapshotSchema = z.union([
  strictObjectSchema(snapshotBaseShape),
  strictObjectSchema({
    ...snapshotBaseShape,
    incarnationId: incarnationIdSchema,
    streamCursor: streamCursorSchema,
  }),
  strictObjectSchema({
    ...snapshotBaseShape,
    incarnationId: incarnationIdSchema,
    streamCursor: streamCursorSchema,
    streamState: streamStateSnapshotSchema,
  }),
]);
export type ThreadSnapshot = z.infer<typeof threadSnapshotSchema>;
