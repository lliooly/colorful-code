import { z } from 'zod';

import {
  createBoundedJsonValueSchema,
  durableCursorSchema,
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
import {
  MAX_STREAM_STATE_SERIALIZED_LENGTH,
  MAX_STREAM_STATE_TOKEN_COUNT,
  MAX_THREAD_STREAM_FRAME_SERIALIZED_LENGTH,
  MAX_THREAD_STREAM_FRAME_TOKEN_COUNT,
} from './stream-limits.js';
import { threadViewSchema } from './thread.js';

const MAX_STREAM_BUFFERS = 100;
const MAX_BUFFER_CONTENT_LENGTH = 1_048_576;
const MAX_BUFFER_JSON_TOKENS = 50_000;

// The preceding bounded schema guarantees JSON wire input. This narrows only
// the downstream input contract; the structural schema still validates it.
const acceptJsonWireInput = <Schema extends z.ZodType>(schema: Schema) =>
  schema as unknown as z.ZodType<z.output<Schema>, JsonValue>;

const boundedToolContentSchema = createBoundedJsonValueSchema(
  MAX_BUFFER_CONTENT_LENGTH,
  MAX_BUFFER_JSON_TOKENS,
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

const rawStreamStateSnapshotSchema = strictObjectSchema({
  assistantBuffers: z
    .array(assistantStreamBufferSchema)
    .max(MAX_STREAM_BUFFERS),
  toolBuffers: z.array(toolStreamBufferSchema).max(MAX_STREAM_BUFFERS),
});

const boundedStreamStateJsonSchema = createBoundedJsonValueSchema(
  MAX_STREAM_STATE_SERIALIZED_LENGTH,
  MAX_STREAM_STATE_TOKEN_COUNT,
);

export const streamStateSnapshotSchema = boundedStreamStateJsonSchema.pipe(
  acceptJsonWireInput(rawStreamStateSnapshotSchema),
);
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

const rawThreadSnapshotSchema = z.union([
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

const decimalCursorIsAtMost = (candidate: string, cutoff: string) =>
  candidate.length < cutoff.length ||
  (candidate.length === cutoff.length && candidate <= cutoff);

const bufferIncarnationMismatchMessage =
  'Stream buffer incarnationId must equal snapshot.incarnationId';
const bufferCutoffMismatchMessage =
  'Stream buffer lastStreamSequence must not exceed snapshot.streamCursor';

export const threadSnapshotSchema = rawThreadSnapshotSchema.superRefine(
  (snapshot, context) => {
    if (!('streamState' in snapshot)) return;

    for (const [bufferKind, buffers] of [
      ['assistantBuffers', snapshot.streamState.assistantBuffers],
      ['toolBuffers', snapshot.streamState.toolBuffers],
    ] as const) {
      for (const [index, buffer] of buffers.entries()) {
        if (buffer.incarnationId !== snapshot.incarnationId) {
          context.addIssue({
            code: 'custom',
            path: ['streamState', bufferKind, index, 'incarnationId'],
            message: bufferIncarnationMismatchMessage,
          });
        }
        if (
          !decimalCursorIsAtMost(
            buffer.lastStreamSequence,
            snapshot.streamCursor,
          )
        ) {
          context.addIssue({
            code: 'custom',
            path: ['streamState', bufferKind, index, 'lastStreamSequence'],
            message: bufferCutoffMismatchMessage,
          });
        }
      }
    }
  },
);
export type ThreadSnapshot = z.infer<typeof threadSnapshotSchema>;

export const snapshotResetReasonSchema = z.enum([
  'cursorExpired',
  'incarnationChanged',
  'daemonRestarted',
  'streamStateUnavailable',
  'runtimeNotLoaded',
]);
export type SnapshotResetReason = z.infer<typeof snapshotResetReasonSchema>;

export const snapshotResetKindSchema = z.literal('stream.snapshotReset');

const snapshotResetBaseShape = {
  kind: snapshotResetKindSchema,
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
const threadIdMismatchMessage =
  'SnapshotReset threadId must equal snapshot.thread.threadId';

const validatedSnapshotResetSchema = z
  .union([durableOnlySnapshotResetSchema, runtimeSnapshotResetSchema])
  .superRefine((frame, context) => {
    if (frame.threadId !== frame.snapshot.thread.threadId) {
      context.addIssue({
        code: 'custom',
        path: ['threadId'],
        message: threadIdMismatchMessage,
      });
    }

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

const boundedSnapshotResetJsonSchema = createBoundedJsonValueSchema(
  MAX_THREAD_STREAM_FRAME_SERIALIZED_LENGTH,
  MAX_THREAD_STREAM_FRAME_TOKEN_COUNT,
);

export const snapshotResetSchema = boundedSnapshotResetJsonSchema.pipe(
  acceptJsonWireInput(validatedSnapshotResetSchema),
);
export type SnapshotReset = z.infer<typeof snapshotResetSchema>;
