import { describe, expect, test } from 'bun:test';
import { z } from 'zod';

import {
  assistantTranscriptPayloadSchema,
  queueItemViewSchema,
  queueViewSchema,
  transcriptItemViewSchema,
} from '@colorful-code/schema/queue';

const timestamp = '2026-07-15T10:00:00+08:00';

const inputFixture = {
  inputItemId: 'input-1',
  threadId: 'thread-1',
  role: 'user',
  source: 'submission',
  content: { kind: 'text', text: 'hello' },
  supersedesInputItemId: null,
  createdAt: timestamp,
};

const queueItemFixture = {
  queueItemId: 'queue-1',
  threadId: 'thread-1',
  input: inputFixture,
  status: 'queued',
  sourceRunId: null,
  resultingRunId: null,
  revision: 1,
  createdAt: timestamp,
  updatedAt: timestamp,
};

const transcriptBase = {
  transcriptItemId: 'transcript-1',
  threadId: 'thread-1',
  runId: 'run-1',
  createdAt: timestamp,
};

describe('Queue resources', () => {
  test('preserves control intent while an indeterminate blocker is effective', () => {
    const queue = {
      threadId: 'thread-1',
      items: [queueItemFixture],
      controlState: 'pausedByStop',
      blockedByIndeterminate: true,
      effectiveState: 'blockedByIndeterminate',
      revision: 2,
    };

    expect(queueViewSchema.parse(queue)).toEqual(queue);
  });

  test('rejects an effective state that disagrees with blocker and control state', () => {
    const queue = {
      threadId: 'thread-1',
      items: [queueItemFixture],
      controlState: 'pausedByStop',
      blockedByIndeterminate: true,
      effectiveState: 'pausedByStop',
      revision: 2,
    };

    expect(queueViewSchema.safeParse(queue).success).toBe(false);
    expect(
      queueViewSchema.safeParse({
        ...queue,
        blockedByIndeterminate: false,
        effectiveState: 'blockedByIndeterminate',
      }).success,
    ).toBe(false);
  });

  test('embeds the immutable public InputItemView without widening it', () => {
    expect(queueItemViewSchema.parse(queueItemFixture)).toEqual(
      queueItemFixture,
    );

    for (const internalField of [
      'updatedAt',
      'revision',
      'workerId',
      'routingKey',
    ]) {
      expect(
        queueItemViewSchema.safeParse({
          ...queueItemFixture,
          input: { ...inputFixture, [internalField]: 'internal' },
        }).success,
      ).toBe(false);
    }
  });

  test('rejects server ordering and projection internals', () => {
    for (const internalField of [
      'position',
      'positionKey',
      'rank',
      'sortKey',
      'leaseEpoch',
      'workerId',
      'projectionRevision',
    ]) {
      expect(
        queueItemViewSchema.safeParse({
          ...queueItemFixture,
          [internalField]: 'internal',
        }).success,
      ).toBe(false);
      expect(
        queueViewSchema.safeParse({
          threadId: 'thread-1',
          items: [queueItemFixture],
          controlState: 'active',
          blockedByIndeterminate: false,
          effectiveState: 'active',
          revision: 2,
          [internalField]: 'internal',
        }).success,
      ).toBe(false);
    }
  });
});

describe('TranscriptItemView', () => {
  test('accepts exactly the five public kind branches', () => {
    const items = [
      { ...transcriptBase, kind: 'input', payload: { input: inputFixture } },
      {
        ...transcriptBase,
        kind: 'assistant',
        payload: {
          status: 'completed',
          content: { text: 'done' },
          finishReason: 'stop',
        },
      },
      {
        ...transcriptBase,
        kind: 'tool',
        payload: {
          toolExecutionId: 'tool-execution-1',
          content: { summary: 'updated one file' },
        },
      },
      {
        ...transcriptBase,
        kind: 'system',
        payload: { content: { message: 'run paused' } },
      },
      {
        ...transcriptBase,
        kind: 'operation',
        payload: {
          operationId: 'operation-1',
          status: 'completed',
          content: { summary: 'stop completed' },
        },
      },
    ];

    for (const item of items) {
      expect(transcriptItemViewSchema.parse(item)).toEqual(item);
    }
  });

  test('uses an immutable public input in the input branch', () => {
    expect(
      transcriptItemViewSchema.safeParse({
        ...transcriptBase,
        kind: 'input',
        payload: { input: inputFixture },
      }).success,
    ).toBe(true);

    expect(
      transcriptItemViewSchema.safeParse({
        ...transcriptBase,
        kind: 'input',
        payload: {
          input: { ...inputFixture, updatedAt: timestamp },
        },
      }).success,
    ).toBe(false);
  });

  test('discriminates assistant status and fixes finish reason semantics', () => {
    const valid = [
      { status: 'streaming', content: 'partial', finishReason: null },
      {
        status: 'interrupted',
        content: { text: 'partial' },
        finishReason: 'daemonLost',
      },
      { status: 'completed', content: ['done'], finishReason: 'stop' },
    ];
    const invalid = [
      { status: 'streaming', content: 'partial' },
      { status: 'streaming', content: 'partial', finishReason: 'stop' },
      { status: 'interrupted', content: 'partial', finishReason: null },
      { status: 'interrupted', content: 'partial' },
      { status: 'completed', content: 'done', finishReason: null },
      { status: 'completed', content: 'done' },
      { status: 'completed', content: BigInt(1), finishReason: 'stop' },
    ];

    for (const payload of valid) {
      expect(assistantTranscriptPayloadSchema.safeParse(payload).success).toBe(
        true,
      );
    }
    for (const payload of invalid) {
      expect(assistantTranscriptPayloadSchema.safeParse(payload).success).toBe(
        false,
      );
    }
  });

  test('keeps tool, system and operation payloads strict and JSON-safe', () => {
    const bases = [
      {
        kind: 'tool',
        payload: {
          toolExecutionId: 'tool-execution-1',
          content: { ok: true },
        },
      },
      { kind: 'system', payload: { content: ['notice'] } },
      {
        kind: 'operation',
        payload: {
          operationId: 'operation-1',
          status: 'waiting',
          content: null,
        },
      },
    ];

    for (const item of bases) {
      expect(
        transcriptItemViewSchema.safeParse({ ...transcriptBase, ...item })
          .success,
      ).toBe(true);
      expect(
        transcriptItemViewSchema.safeParse({
          ...transcriptBase,
          ...item,
          payload: { ...item.payload, content: BigInt(1) },
        }).success,
      ).toBe(false);
      expect(
        transcriptItemViewSchema.safeParse({
          ...transcriptBase,
          ...item,
          payload: { ...item.payload, extra: true },
        }).success,
      ).toBe(false);
    }
  });

  test('rejects raw tool output, secrets and execution internals', () => {
    for (const internalField of [
      'rawStdout',
      'rawStderr',
      'stdout',
      'stderr',
      'secret',
      'attemptId',
      'routingKey',
      'workerId',
      'leaseEpoch',
      'projectionRevision',
    ]) {
      expect(
        transcriptItemViewSchema.safeParse({
          ...transcriptBase,
          kind: 'tool',
          payload: {
            toolExecutionId: 'tool-execution-1',
            content: { ok: true },
            [internalField]: 'internal',
          },
        }).success,
      ).toBe(false);
    }
  });

  test('remains exportable to JSON Schema with discriminated branches', () => {
    const jsonSchema = z.toJSONSchema(transcriptItemViewSchema);

    expect(jsonSchema.oneOf).toHaveLength(5);
  });
});
