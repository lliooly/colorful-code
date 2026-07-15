import { describe, expect, test } from 'bun:test';
import { threadSnapshotSchema } from '@colorful-code/schema/snapshot';

const at = '2026-07-15T10:00:00+08:00';
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
  durableCursor: '9007199254740993',
  snapshotVersion: 1,
};

describe('ThreadSnapshot', () => {
  test('parses a bounded durable-only snapshot and omits activeRun', () => {
    expect(threadSnapshotSchema.parse(snapshot)).toEqual(snapshot);
    expect(
      threadSnapshotSchema.safeParse({ ...snapshot, activeRun: null }).success,
    ).toBe(false);
  });
  test('requires runtime cursors as a pair and for stream state', () => {
    expect(
      threadSnapshotSchema.safeParse({ ...snapshot, incarnationId: 'inc-1' })
        .success,
    ).toBe(false);
    expect(
      threadSnapshotSchema.safeParse({ ...snapshot, streamCursor: '1' })
        .success,
    ).toBe(false);
    const runtime = { ...snapshot, incarnationId: 'inc-1', streamCursor: '1' };
    expect(threadSnapshotSchema.safeParse(runtime).success).toBe(true);
    expect(
      threadSnapshotSchema.safeParse({
        ...snapshot,
        streamState: {
          status: 'streaming',
          interruptionReason: null,
          messageBuffers: [],
          toolBuffers: [],
        },
      }).success,
    ).toBe(false);
    expect(
      threadSnapshotSchema.safeParse({
        ...runtime,
        streamState: {
          status: 'interrupted',
          interruptionReason: 'daemonLost',
          messageBuffers: [
            { transcriptItemId: 'transcript-1', text: 'partial' },
          ],
          toolBuffers: [],
        },
      }).success,
    ).toBe(true);
  });
});
