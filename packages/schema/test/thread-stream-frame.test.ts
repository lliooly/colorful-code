import { describe, expect, test } from 'bun:test';
import { z } from 'zod';

import {
  eventAttachAcceptedResponseSchema,
  eventAttachParamsSchema,
  eventAttachQuerySchema,
  eventAttachResetResponseSchema,
  eventAttachResponseSchema,
  httpContractRegistry,
} from '@colorful-code/schema/commands';
import {
  parseThreadStreamFrame,
  parseThreadStreamFrameResultSchema,
  threadStreamFrameSchema,
} from '@colorful-code/schema/events';

const occurredAt = '2026-07-17T10:30:00+08:00';

const knownTransient = {
  eventId: 'event-known-transient',
  threadId: 'thread-1',
  kind: 'assistant.textDelta',
  critical: false,
  occurredAt,
  payload: { transcriptItemId: 'transcript-1', chunk: 'hello' },
  durability: 'transient',
  incarnationId: 'incarnation-1',
  streamSequence: '43',
  durableBasis: '41',
} as const;

const unknownDurable = {
  eventId: 'event-unknown-durable',
  threadId: 'thread-1',
  kind: 'plugin.futureDurable',
  critical: false,
  occurredAt,
  payload: { future: true },
  durability: 'durable',
  durableSequence: '42',
} as const;

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
    createdAt: occurredAt,
    updatedAt: occurredAt,
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
} as const;

const snapshotReset = {
  kind: 'stream.snapshotReset',
  resetId: 'reset-1',
  threadId: 'thread-1',
  reason: 'runtimeNotLoaded',
  snapshot,
  durableCursor: '41',
} as const;

describe('ThreadStreamFrame wire contract', () => {
  test('accepts known, reset, and unknown wire frames', () => {
    for (const frame of [knownTransient, snapshotReset, unknownDurable]) {
      expect(threadStreamFrameSchema.parse(frame)).toEqual(frame);
    }

    expect(
      threadStreamFrameSchema.safeParse({
        ...unknownDurable,
        critical: true,
      }).success,
    ).toBe(true);
  });

  test('keeps reset outside both sequence spaces and event cursors disjoint', () => {
    for (const extra of [
      { durability: 'durable', durableSequence: '42' },
      {
        durability: 'transient',
        incarnationId: 'incarnation-1',
        streamSequence: '43',
        durableBasis: '41',
      },
    ]) {
      expect(
        threadStreamFrameSchema.safeParse({ ...snapshotReset, ...extra })
          .success,
      ).toBe(false);
    }

    expect(
      threadStreamFrameSchema.safeParse({
        ...knownTransient,
        durableSequence: '42',
      }).success,
    ).toBe(false);
    expect(
      threadStreamFrameSchema.safeParse({
        ...unknownDurable,
        streamSequence: '43',
      }).success,
    ).toBe(false);
  });
});

describe('parseThreadStreamFrame result contract', () => {
  test('matches all four parser outcomes exactly', () => {
    const inputs = [
      knownTransient,
      unknownDurable,
      { ...unknownDurable, critical: true },
      { ...knownTransient, streamSequence: 43 },
    ];

    expect(
      inputs.map((input) => parseThreadStreamFrame(input).outcome),
    ).toEqual([
      'known',
      'unknownNonCritical',
      'resetRequired',
      'protocolError',
    ]);
    for (const input of inputs) {
      const result = parseThreadStreamFrame(input);
      expect(parseThreadStreamFrameResultSchema.parse(result)).toEqual(result);
    }
  });

  test('does not publish critical unknown frames as safely skippable results', () => {
    expect(
      parseThreadStreamFrameResultSchema.safeParse({
        outcome: 'unknownNonCritical',
        frame: { ...unknownDurable, critical: true },
      }).success,
    ).toBe(false);
    expect(
      parseThreadStreamFrameResultSchema.safeParse({
        outcome: 'resetRequired',
        reason: 'criticalUnknownEvent',
        eventId: unknownDurable.eventId,
        kind: unknownDurable.kind,
        frame: unknownDurable,
      }).success,
    ).toBe(false);
  });
});

describe('event attach dual cursor contract', () => {
  test('uses a structural union for absent or complete runtime cursors', () => {
    const valid = [
      {},
      { durableAfter: '41' },
      { incarnationId: 'incarnation-1', streamAfter: '43' },
      {
        durableAfter: '41',
        incarnationId: 'incarnation-1',
        streamAfter: '43',
      },
    ];
    for (const value of valid) {
      expect(eventAttachParamsSchema.parse(value)).toEqual(value);
      expect(eventAttachQuerySchema.parse(value)).toEqual(value);
    }

    for (const value of [
      { incarnationId: 'incarnation-1' },
      { streamAfter: '43' },
      { durableAfter: '41', lastEventId: '43' },
      { lastEventId: '43' },
      { durableAfter: '41', extra: true },
    ]) {
      expect(eventAttachParamsSchema.safeParse(value).success).toBe(false);
    }
  });

  test('publishes strict accepted and reset response variants', () => {
    const durableAccepted = { outcome: 'accepted', durableCursor: '41' };
    const runtimeAccepted = {
      outcome: 'accepted',
      durableCursor: '41',
      incarnationId: 'incarnation-1',
      streamCursor: '43',
    };
    const reset = { outcome: 'reset', frame: snapshotReset };

    for (const value of [durableAccepted, runtimeAccepted]) {
      expect(eventAttachAcceptedResponseSchema.parse(value)).toEqual(value);
      expect(eventAttachResponseSchema.parse(value)).toEqual(value);
    }
    expect(eventAttachResetResponseSchema.parse(reset)).toEqual(reset);
    expect(eventAttachResponseSchema.parse(reset)).toEqual(reset);

    for (const invalid of [
      { ...durableAccepted, incarnationId: 'incarnation-1' },
      { ...durableAccepted, streamCursor: '43' },
      { ...runtimeAccepted, streamCursor: undefined },
      { ...durableAccepted, lastEventId: '43' },
      { ...reset, durableCursor: '41' },
    ]) {
      expect(eventAttachResponseSchema.safeParse(invalid).success).toBe(false);
    }
  });

  test('keeps the event registry query alias and streaming result boundary', () => {
    const endpoint = httpContractRegistry['event.attach'];

    expect(endpoint.querySchema).toBe(eventAttachQuerySchema);
    expect(endpoint.resultSchema.safeParse(undefined).success).toBe(true);
    expect(
      endpoint.resultSchema.safeParse({ outcome: 'accepted' }).success,
    ).toBe(false);
  });
});

describe('causal basis JSON Schema contract', () => {
  test('describes the two incomparable cursor spaces as existing high-watermarks', () => {
    const jsonSchema = z.toJSONSchema(threadStreamFrameSchema);
    const properties: Record<
      string,
      { type?: unknown; description?: unknown }[]
    > = {};
    const pending: unknown[] = [jsonSchema];
    const visited = new Set<object>();

    while (pending.length > 0) {
      const value = pending.pop();
      if (value === null || typeof value !== 'object' || visited.has(value)) {
        continue;
      }
      visited.add(value);
      const entries = Object.entries(value);
      for (const [key, child] of entries) {
        if (
          key === 'properties' &&
          child !== null &&
          typeof child === 'object'
        ) {
          for (const [name, schema] of Object.entries(child)) {
            if (schema !== null && typeof schema === 'object') {
              (properties[name] ??= []).push(schema);
            }
          }
        }
        pending.push(child);
      }
    }

    for (const name of ['durableSequence', 'streamSequence', 'durableBasis']) {
      expect(properties[name]?.some((schema) => schema.type === 'string')).toBe(
        true,
      );
    }

    const durableDescription = properties.durableBasis
      ?.map(({ description }) => description)
      .find((description): description is string =>
        description?.includes('pre-existing high-watermark'),
      );
    const streamDescription = properties.streamBasis
      ?.map(({ description }) => description)
      .find((description): description is string =>
        description?.includes('pre-existing high-watermark'),
      );

    expect(durableDescription).toContain('durable cursor space');
    expect(durableDescription).toContain('must not be compared');
    expect(streamDescription).toContain('specific incarnation stream space');
    expect(streamDescription).toContain('must not be compared');
    expect(streamDescription).toContain('not a third cursor');
  });
});
