import { describe, expect, test } from 'bun:test';
import { z } from 'zod';

import {
  inputContentSchema,
  inputItemViewSchema,
  threadViewSchema,
  workspaceBindingSchema,
} from '@colorful-code/schema/thread';
import {
  runTerminalReasonSchema,
  runViewSchema,
} from '@colorful-code/schema/run';

const timestamp = '2026-07-15T10:00:00+08:00';

const threadFixture = {
  threadId: 'thread-1',
  lineageId: 'lineage-1',
  parentThreadId: null,
  lifecycle: 'available',
  runtimeStatus: 'idle',
  title: null,
  goal: null,
  workspaceBinding: {
    workspaceId: 'workspace-1',
    displayPath: '/workspace/project',
    trust: 'trusted',
  },
  activeRunId: null,
  threadRevision: 1,
  queueRevision: 2,
  configRevision: 3,
  policyRevision: 4,
  createdAt: timestamp,
  updatedAt: timestamp,
};

const runFixture = {
  runId: 'run-1',
  threadId: 'thread-1',
  kind: 'interactive',
  status: 'running',
  sourceInputItemId: 'input-1',
  sourceQueueItemId: null,
  planGeneration: 0,
  configRevision: 3,
  policyRevision: 4,
  terminalReason: null,
  startedAt: timestamp,
  endedAt: null,
  createdAt: timestamp,
  updatedAt: timestamp,
  revision: 1,
};

const inputFixture = {
  inputItemId: 'input-1',
  threadId: 'thread-1',
  role: 'user',
  source: 'submission',
  content: { kind: 'text', text: 'hello' },
  supersedesInputItemId: null,
  createdAt: timestamp,
};

describe('ThreadView', () => {
  test('parses a minimal public resource with present nullable fields', () => {
    expect(threadViewSchema.parse(threadFixture)).toEqual(threadFixture);
  });

  for (const field of [
    'parentThreadId',
    'activeRunId',
    'title',
    'goal',
  ] as const) {
    test(`requires nullable field ${field} to be present`, () => {
      const fixture = { ...threadFixture };
      delete fixture[field];

      expect(threadViewSchema.safeParse(fixture).success).toBe(false);
    });
  }

  test('keeps deletedAt optional and nullable at the schema boundary', () => {
    expect(threadViewSchema.safeParse(threadFixture).success).toBe(true);
    expect(
      threadViewSchema.safeParse({
        ...threadFixture,
        lifecycle: 'deleted',
        deletedAt: null,
      }).success,
    ).toBe(true);
    expect(
      threadViewSchema.safeParse({
        ...threadFixture,
        lifecycle: 'deleted',
        deletedAt: timestamp,
      }).success,
    ).toBe(true);
  });

  test('rejects deletedAt outside the deleted lifecycle', () => {
    for (const lifecycle of ['available', 'archived']) {
      for (const deletedAt of [null, timestamp]) {
        expect(
          threadViewSchema.safeParse({
            ...threadFixture,
            lifecycle,
            deletedAt,
          }).success,
        ).toBe(false);
      }
    }
  });

  test('preserves the lifecycle constraint in generated JSON Schema', () => {
    const jsonSchema = z.toJSONSchema(threadViewSchema);

    expect(jsonSchema.oneOf).toHaveLength(3);
  });

  test('rejects runtime, lease and projection internals', () => {
    for (const internalField of [
      'leaseEpoch',
      'workerId',
      'runtimeSessionId',
      'projectionRevision',
      'clientIdentity',
    ]) {
      expect(
        threadViewSchema.safeParse({
          ...threadFixture,
          [internalField]: 'internal',
        }).success,
      ).toBe(false);
    }
  });

  test('workspace binding is strict and contains only public fields', () => {
    expect(
      workspaceBindingSchema.safeParse(threadFixture.workspaceBinding).success,
    ).toBe(true);
    for (const internalField of ['routingKey', 'lockId', 'workerId']) {
      expect(
        workspaceBindingSchema.safeParse({
          ...threadFixture.workspaceBinding,
          [internalField]: 'internal',
        }).success,
      ).toBe(false);
    }
  });
});

describe('RunView', () => {
  test('parses a minimal public resource', () => {
    expect(runViewSchema.parse(runFixture)).toEqual(runFixture);
  });

  test('requires terminalReason to be present while allowing null', () => {
    const fixture = { ...runFixture };
    delete fixture.terminalReason;

    expect(runViewSchema.safeParse(fixture).success).toBe(false);
    expect(runViewSchema.safeParse(runFixture).success).toBe(true);
  });

  test('uses a strict JSON-safe terminal reason', () => {
    expect(
      runTerminalReasonSchema.safeParse({
        code: 'MODEL_ERROR',
        message: 'provider unavailable',
        details: { retryable: true },
      }).success,
    ).toBe(true);
    expect(
      runTerminalReasonSchema.safeParse({
        code: 'MODEL_ERROR',
        details: undefined,
        workerId: 'worker-1',
      }).success,
    ).toBe(false);
    expect(
      runTerminalReasonSchema.safeParse({
        code: 'MODEL_ERROR',
        details: BigInt(1),
      }).success,
    ).toBe(false);
  });

  test('rejects runtime, lease and projection internals', () => {
    for (const internalField of [
      'leaseEpoch',
      'workerId',
      'runtimeSessionId',
      'projectionRevision',
      'clientIdentity',
    ]) {
      expect(
        runViewSchema.safeParse({
          ...runFixture,
          [internalField]: 'internal',
        }).success,
      ).toBe(false);
    }
  });
});

describe('immutable InputItemView', () => {
  test('parses a minimal immutable input resource', () => {
    expect(inputItemViewSchema.parse(inputFixture)).toEqual(inputFixture);
  });

  test('accepts exactly the three bounded content branches', () => {
    for (const content of [
      { kind: 'text', text: 'hello' },
      { kind: 'structured', value: { prompt: ['hello', 1, true, null] } },
      { kind: 'artifactReferences', artifactIds: ['artifact-1'] },
    ]) {
      expect(inputContentSchema.safeParse(content).success).toBe(true);
      expect(
        inputItemViewSchema.safeParse({ ...inputFixture, content }).success,
      ).toBe(true);
    }
  });

  test('rejects empty or unbounded input content', () => {
    for (const content of [
      { kind: 'text', text: '' },
      { kind: 'structured', value: BigInt(1) },
      { kind: 'artifactReferences', artifactIds: [] },
      { kind: 'binary', bytes: 'AA==' },
      { arbitrary: true },
    ]) {
      expect(inputContentSchema.safeParse(content).success).toBe(false);
      expect(
        inputItemViewSchema.safeParse({ ...inputFixture, content }).success,
      ).toBe(false);
    }
  });

  test('rejects mutable and server-internal fields', () => {
    for (const internalField of [
      'updatedAt',
      'revision',
      'leaseEpoch',
      'workerId',
      'runtimeSessionId',
      'projectionRevision',
      'clientIdentity',
    ]) {
      expect(
        inputItemViewSchema.safeParse({
          ...inputFixture,
          [internalField]: 'internal',
        }).success,
      ).toBe(false);
    }
  });
});
