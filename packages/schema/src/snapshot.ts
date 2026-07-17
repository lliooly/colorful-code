import { z } from 'zod';

import {
  durableCursorSchema,
  jsonValueSchema,
  type JsonValue,
  pageSchema,
  revisionSchema,
  streamCursorSchema,
  strictObjectSchema,
  timestampSchema,
} from './common.js';
import {
  streamInterruptionReasonSchema,
  streamStateStatusSchema,
} from './enums.js';
import {
  incarnationIdSchema,
  resetIdSchema,
  runIdSchema,
  threadIdSchema,
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

const MAX_STREAM_BUFFERS = 100;
const MAX_BUFFER_CONTENT_LENGTH = 1_048_576;

const hasSerializedJsonLengthAtMost = (root: JsonValue, limit: number) => {
  const pending: JsonValue[] = [root];
  let length = 0;

  while (pending.length > 0) {
    const value = pending.pop();
    if (value === undefined) return false;

    if (value === null) {
      length += 4;
    } else if (typeof value === 'string') {
      length += JSON.stringify(value).length;
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      length += String(value).length;
    } else if (Array.isArray(value)) {
      length += 2 + Math.max(0, value.length - 1);
      for (let index = value.length - 1; index >= 0; index -= 1) {
        const item = value[index];
        if (item === undefined) return false;
        pending.push(item);
      }
    } else {
      const entries = Object.entries(value);
      length += 2 + Math.max(0, entries.length - 1);
      for (const [key, item] of entries) {
        length += JSON.stringify(key).length + 1;
        pending.push(item);
      }
    }

    if (length > limit) return false;
  }

  return true;
};

const boundedToolContentSchema = jsonValueSchema.refine(
  (value) => hasSerializedJsonLengthAtMost(value, MAX_BUFFER_CONTENT_LENGTH),
  { message: 'Tool stream buffer content exceeds the size limit' },
);

const streamBufferFenceShape = {
  runId: runIdSchema,
  incarnationId: incarnationIdSchema,
  lastStreamSequence: streamCursorSchema,
};

const createStreamBufferSchema = <Shape extends z.ZodRawShape>(shape: Shape) =>
  z.discriminatedUnion('status', [
    strictObjectSchema({
      ...shape,
      ...streamBufferFenceShape,
      status: z.literal(streamStateStatusSchema.enum.streaming),
      terminalAt: z.null(),
      interruptionReason: z.null(),
    }),
    strictObjectSchema({
      ...shape,
      ...streamBufferFenceShape,
      status: z.literal(streamStateStatusSchema.enum.completed),
      terminalAt: timestampSchema,
      interruptionReason: z.null(),
    }),
    strictObjectSchema({
      ...shape,
      ...streamBufferFenceShape,
      status: z.literal(streamStateStatusSchema.enum.interrupted),
      terminalAt: timestampSchema,
      interruptionReason: streamInterruptionReasonSchema,
    }),
  ]);

export const assistantStreamBufferSchema = createStreamBufferSchema({
  transcriptItemId: transcriptItemIdSchema,
  text: z.string().max(MAX_BUFFER_CONTENT_LENGTH),
});
export type AssistantStreamBuffer = z.infer<typeof assistantStreamBufferSchema>;

export const toolStreamBufferSchema = createStreamBufferSchema({
  toolExecutionId: toolExecutionIdSchema,
  content: boundedToolContentSchema,
});
export type ToolStreamBuffer = z.infer<typeof toolStreamBufferSchema>;

export const streamStateSnapshotSchema = strictObjectSchema({
  assistantBuffers: z
    .array(assistantStreamBufferSchema)
    .max(MAX_STREAM_BUFFERS),
  toolBuffers: z.array(toolStreamBufferSchema).max(MAX_STREAM_BUFFERS),
});
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

export const snapshotResetReasonSchema = z.enum([
  'cursorExpired',
  'incarnationChanged',
  'daemonRestarted',
  'streamStateUnavailable',
  'runtimeNotLoaded',
]);
export type SnapshotResetReason = z.infer<typeof snapshotResetReasonSchema>;

const snapshotResetBaseShape = {
  kind: z.literal('stream.snapshotReset'),
  resetId: resetIdSchema,
  threadId: threadIdSchema,
  reason: snapshotResetReasonSchema,
  snapshot: threadSnapshotSchema,
  durableCursor: durableCursorSchema,
};

const durableOnlySnapshotResetSchema = strictObjectSchema(
  snapshotResetBaseShape,
);
const runtimeSnapshotResetSchema = strictObjectSchema({
  ...snapshotResetBaseShape,
  incarnationId: incarnationIdSchema,
  streamCursor: streamCursorSchema,
});

const durableCursorMismatchMessage =
  'SnapshotReset durableCursor must equal snapshot.durableCursor';
const incarnationMismatchMessage =
  'SnapshotReset incarnationId must equal snapshot.incarnationId';
const streamCursorMismatchMessage =
  'SnapshotReset streamCursor must equal snapshot.streamCursor';

export const snapshotResetSchema = z
  .union([durableOnlySnapshotResetSchema, runtimeSnapshotResetSchema])
  .superRefine((frame, context) => {
    if (frame.durableCursor !== frame.snapshot.durableCursor) {
      context.addIssue({
        code: 'custom',
        path: ['durableCursor'],
        message: durableCursorMismatchMessage,
      });
    }

    const frameIncarnationId =
      'incarnationId' in frame ? frame.incarnationId : undefined;
    const snapshotIncarnationId =
      'incarnationId' in frame.snapshot
        ? frame.snapshot.incarnationId
        : undefined;
    const frameStreamCursor =
      'streamCursor' in frame ? frame.streamCursor : undefined;
    const snapshotStreamCursor =
      'streamCursor' in frame.snapshot
        ? frame.snapshot.streamCursor
        : undefined;
    const frameHasRuntime = frameIncarnationId !== undefined;
    const snapshotHasRuntime = snapshotIncarnationId !== undefined;

    if (
      frameHasRuntime !== snapshotHasRuntime ||
      frameIncarnationId !== snapshotIncarnationId
    ) {
      context.addIssue({
        code: 'custom',
        path: ['incarnationId'],
        message: incarnationMismatchMessage,
      });
    }

    if (
      frameHasRuntime !== snapshotHasRuntime ||
      frameStreamCursor !== snapshotStreamCursor
    ) {
      context.addIssue({
        code: 'custom',
        path: ['streamCursor'],
        message: streamCursorMismatchMessage,
      });
    }

    if (!frameHasRuntime && 'streamState' in frame.snapshot) {
      context.addIssue({
        code: 'custom',
        path: ['snapshot', 'streamState'],
        message: 'SnapshotReset without runtime must not include streamState',
      });
    }
  });
export type SnapshotReset = z.infer<typeof snapshotResetSchema>;
