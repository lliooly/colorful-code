import { describe, expect, test } from 'bun:test';
import { z } from 'zod';

import {
  snapshotResetSchema,
  streamStateSnapshotSchema,
} from '@colorful-code/schema/snapshot';

const at = '2026-07-17T10:00:00+08:00';
const MAX_STREAM_BUFFERS = 100;
const MAX_BUFFER_CONTENT_LENGTH = 1_048_576;

const snapshot = {
  thread: {
    threadId: 'thread-1',
    lineageId: 'lineage-1',
    parentThreadId: null,
    lifecycle: 'available',
    runtimeStatus: 'idle',
    title: null,
    goal: null,
    workspaceBinding: {
      workspaceId: 'workspace-1',
      displayPath: '/workspace',
      trust: 'trusted',
    },
    activeRunId: null,
    threadRevision: 1,
    queueRevision: 1,
    configRevision: 1,
    policyRevision: 1,
    createdAt: at,
    updatedAt: at,
  },
  recentRuns: { items: [], pageInfo: { nextCursor: null, hasMore: false } },
  queue: {
    threadId: 'thread-1',
    items: [],
    controlState: 'active',
    blockedByIndeterminate: false,
    effectiveState: 'active',
    revision: 1,
  },
  pendingOperations: [],
  pendingApprovals: [],
  transcript: { items: [], pageInfo: { nextCursor: null, hasMore: false } },
  toolExecutions: [],
  durableCursor: '41',
  snapshotVersion: 1,
};

const assistantStreaming = {
  transcriptItemId: 'transcript-1',
  runId: 'run-1',
  incarnationId: 'incarnation-1',
  lastStreamSequence: '42',
  status: 'streaming',
  terminalAt: null,
  interruptionReason: null,
  text: '  partial\n',
} as const;

const toolStreaming = {
  toolExecutionId: 'tool-execution-1',
  runId: 'run-1',
  incarnationId: 'incarnation-1',
  lastStreamSequence: '43',
  status: 'streaming',
  terminalAt: null,
  interruptionReason: null,
  content: { stdout: ' partial ' },
} as const;

const runtimeSnapshot = {
  ...snapshot,
  incarnationId: 'incarnation-1',
  streamCursor: '43',
  streamState: {
    assistantBuffers: [assistantStreaming],
    toolBuffers: [toolStreaming],
  },
};

const durableReset = {
  kind: 'stream.snapshotReset',
  resetId: 'reset-1',
  threadId: 'thread-1',
  reason: 'runtimeNotLoaded',
  snapshot,
  durableCursor: '41',
} as const;

const runtimeReset = {
  ...durableReset,
  reason: 'cursorExpired',
  snapshot: runtimeSnapshot,
  incarnationId: 'incarnation-1',
  streamCursor: '43',
} as const;

describe('StreamStateSnapshot', () => {
  test('binds each assistant and tool buffer to its run and incarnation', () => {
    const parsed = streamStateSnapshotSchema.parse({
      assistantBuffers: [assistantStreaming],
      toolBuffers: [toolStreaming],
    });

    expect(parsed).toEqual({
      assistantBuffers: [assistantStreaming],
      toolBuffers: [toolStreaming],
    });
    expect(parsed.assistantBuffers[0]?.text).toBe('  partial\n');

    for (const field of [
      'runId',
      'incarnationId',
      'lastStreamSequence',
      'status',
      'terminalAt',
      'interruptionReason',
    ] as const) {
      const invalid = { ...assistantStreaming } as Record<string, unknown>;
      delete invalid[field];
      expect(
        streamStateSnapshotSchema.safeParse({
          assistantBuffers: [invalid],
          toolBuffers: [],
        }).success,
      ).toBe(false);
    }
  });

  test('requires terminal timestamps only for terminal buffer states', () => {
    const completed = {
      ...assistantStreaming,
      status: 'completed',
      terminalAt: at,
    } as const;
    const interrupted = {
      ...toolStreaming,
      status: 'interrupted',
      terminalAt: at,
      interruptionReason: 'daemonLost',
    } as const;

    expect(
      streamStateSnapshotSchema.safeParse({
        assistantBuffers: [completed],
        toolBuffers: [interrupted],
      }).success,
    ).toBe(true);
    expect(
      streamStateSnapshotSchema.safeParse({
        assistantBuffers: [{ ...completed, terminalAt: null }],
        toolBuffers: [],
      }).success,
    ).toBe(false);
    expect(
      streamStateSnapshotSchema.safeParse({
        assistantBuffers: [],
        toolBuffers: [{ ...interrupted, interruptionReason: null }],
      }).success,
    ).toBe(false);
    expect(
      streamStateSnapshotSchema.safeParse({
        assistantBuffers: [{ ...assistantStreaming, terminalAt: at }],
        toolBuffers: [],
      }).success,
    ).toBe(false);
  });

  test('bounds buffer arrays independently', () => {
    expect(
      streamStateSnapshotSchema.safeParse({
        assistantBuffers: Array.from(
          { length: MAX_STREAM_BUFFERS },
          (_, index) => ({
            ...assistantStreaming,
            transcriptItemId: `transcript-${index}`,
          }),
        ),
        toolBuffers: [],
      }).success,
    ).toBe(true);
    expect(
      streamStateSnapshotSchema.safeParse({
        assistantBuffers: Array.from(
          { length: MAX_STREAM_BUFFERS + 1 },
          (_, index) => ({
            ...assistantStreaming,
            transcriptItemId: `transcript-${index}`,
          }),
        ),
        toolBuffers: [],
      }).success,
    ).toBe(false);
    expect(
      streamStateSnapshotSchema.safeParse({
        assistantBuffers: [],
        toolBuffers: Array.from(
          { length: MAX_STREAM_BUFFERS + 1 },
          (_, index) => ({
            ...toolStreaming,
            toolExecutionId: `tool-execution-${index}`,
          }),
        ),
      }).success,
    ).toBe(false);
  });

  test('bounds assistant text without trimming meaningful whitespace', () => {
    const atLimit = ' '.repeat(MAX_BUFFER_CONTENT_LENGTH);

    expect(
      streamStateSnapshotSchema.parse({
        assistantBuffers: [{ ...assistantStreaming, text: atLimit }],
        toolBuffers: [],
      }).assistantBuffers[0]?.text,
    ).toBe(atLimit);
    expect(
      streamStateSnapshotSchema.safeParse({
        assistantBuffers: [{ ...assistantStreaming, text: `${atLimit}x` }],
        toolBuffers: [],
      }).success,
    ).toBe(false);
  });

  test('bounds tool JSON by its serialized content length', () => {
    const atLimit = 'x'.repeat(MAX_BUFFER_CONTENT_LENGTH - 2);

    expect(
      streamStateSnapshotSchema.safeParse({
        assistantBuffers: [],
        toolBuffers: [{ ...toolStreaming, content: atLimit }],
      }).success,
    ).toBe(true);
    expect(
      streamStateSnapshotSchema.safeParse({
        assistantBuffers: [],
        toolBuffers: [{ ...toolStreaming, content: `${atLimit}x` }],
      }).success,
    ).toBe(false);
  });

  test('rejects hostile tool content and counts deep JSON without throwing', () => {
    const deeplyNested: Record<string, unknown> = {};
    let tail = deeplyNested;
    for (let depth = 0; depth < 15_000; depth += 1) {
      const next: Record<string, unknown> = {};
      tail.value = next;
      tail = next;
    }

    const hostile = new Proxy(
      {},
      {
        getPrototypeOf: () => {
          throw new Error('hostile prototype trap');
        },
      },
    );

    for (const content of [deeplyNested, hostile]) {
      expect(() =>
        streamStateSnapshotSchema.safeParse({
          assistantBuffers: [],
          toolBuffers: [{ ...toolStreaming, content }],
        }),
      ).not.toThrow();
    }
    expect(
      streamStateSnapshotSchema.safeParse({
        assistantBuffers: [],
        toolBuffers: [{ ...toolStreaming, content: deeplyNested }],
      }).success,
    ).toBe(true);
    expect(
      streamStateSnapshotSchema.safeParse({
        assistantBuffers: [],
        toolBuffers: [{ ...toolStreaming, content: hostile }],
      }).success,
    ).toBe(false);
  });

  test('rejects wide tool content before reading every data descriptor', () => {
    const source = Object.fromEntries(
      Array.from({ length: 2_500 }, (_, index) => [
        `key-${index}`,
        'x'.repeat(1_000),
      ]),
    );
    let descriptorReads = 0;
    const observed = new Proxy(source, {
      getOwnPropertyDescriptor: (target, key) => {
        descriptorReads += 1;
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });

    expect(
      streamStateSnapshotSchema.safeParse({
        assistantBuffers: [],
        toolBuffers: [{ ...toolStreaming, content: observed }],
      }).success,
    ).toBe(false);
    expect(descriptorReads).toBeLessThan(Object.keys(source).length);
  });

  test('returns detached tool content', () => {
    const content = { nested: ['before'] };
    const parsed = streamStateSnapshotSchema.parse({
      assistantBuffers: [],
      toolBuffers: [{ ...toolStreaming, content }],
    });

    expect(parsed.toolBuffers[0]?.content).not.toBe(content);
    content.nested[0] = 'after';
    expect(parsed.toolBuffers[0]?.content).toEqual({ nested: ['before'] });
  });

  test('is strict and remains JSON Schema exportable', () => {
    expect(
      streamStateSnapshotSchema.safeParse({
        assistantBuffers: [{ ...assistantStreaming, extra: true }],
        toolBuffers: [],
      }).success,
    ).toBe(false);
    expect(() => z.toJSONSchema(streamStateSnapshotSchema)).not.toThrow();
  });
});

describe('SnapshotReset', () => {
  test('accepts strict durable-only and runtime reset frames', () => {
    expect(snapshotResetSchema.parse(durableReset)).toEqual(durableReset);
    expect(snapshotResetSchema.parse(runtimeReset)).toEqual(runtimeReset);

    for (const reason of [
      'cursorExpired',
      'incarnationChanged',
      'daemonRestarted',
      'streamStateUnavailable',
      'runtimeNotLoaded',
    ] as const) {
      expect(
        snapshotResetSchema.safeParse({ ...runtimeReset, reason }).success,
      ).toBe(true);
    }
    expect(
      snapshotResetSchema.safeParse({
        ...durableReset,
        reason: 'unknownReason',
      }).success,
    ).toBe(false);
    expect(
      snapshotResetSchema.safeParse({
        ...durableReset,
        durability: 'durable',
      }).success,
    ).toBe(false);
    expect(
      snapshotResetSchema.safeParse({
        ...durableReset,
        durableSequence: '42',
      }).success,
    ).toBe(false);
    expect(
      snapshotResetSchema.safeParse({
        ...durableReset,
        eventId: 'event-1',
      }).success,
    ).toBe(false);
  });

  test('rejects a frame durableCursor that differs from its snapshot', () => {
    const result = snapshotResetSchema.safeParse({
      ...durableReset,
      durableCursor: '40',
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.message)).toContain(
        'SnapshotReset durableCursor must equal snapshot.durableCursor',
      );
    }
  });

  test('rejects a partial runtime cursor on the frame', () => {
    expect(
      snapshotResetSchema.safeParse({
        ...durableReset,
        incarnationId: 'incarnation-1',
      }).success,
    ).toBe(false);
    expect(
      snapshotResetSchema.safeParse({
        ...durableReset,
        streamCursor: '43',
      }).success,
    ).toBe(false);
  });

  test('rejects frame runtime cursors when the snapshot has no runtime', () => {
    expect(
      snapshotResetSchema.safeParse({
        ...durableReset,
        incarnationId: 'incarnation-1',
        streamCursor: '43',
      }).success,
    ).toBe(false);
  });

  test('rejects snapshot runtime cursors when the frame has no runtime', () => {
    expect(
      snapshotResetSchema.safeParse({
        ...durableReset,
        snapshot: {
          ...snapshot,
          incarnationId: 'incarnation-1',
          streamCursor: '43',
        },
      }).success,
    ).toBe(false);
  });

  test('rejects stream state when the frame has no runtime', () => {
    expect(
      snapshotResetSchema.safeParse({
        ...durableReset,
        snapshot: runtimeSnapshot,
      }).success,
    ).toBe(false);
  });

  test('rejects an incarnation mismatch independently', () => {
    const result = snapshotResetSchema.safeParse({
      ...runtimeReset,
      incarnationId: 'incarnation-2',
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.message)).toContain(
        'SnapshotReset incarnationId must equal snapshot.incarnationId',
      );
    }
  });

  test('rejects a stream cursor mismatch independently', () => {
    const result = snapshotResetSchema.safeParse({
      ...runtimeReset,
      streamCursor: '44',
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.message)).toContain(
        'SnapshotReset streamCursor must equal snapshot.streamCursor',
      );
    }
  });

  test('requires every field and remains JSON Schema exportable', () => {
    for (const field of [
      'kind',
      'resetId',
      'threadId',
      'reason',
      'snapshot',
      'durableCursor',
    ] as const) {
      const invalid = { ...durableReset } as Record<string, unknown>;
      delete invalid[field];
      expect(snapshotResetSchema.safeParse(invalid).success).toBe(false);
    }

    expect(() => z.toJSONSchema(snapshotResetSchema)).not.toThrow();
  });
});
