import { describe, expect, test } from 'bun:test';
import { z } from 'zod';

import {
  knownDurableEventEnvelopeSchema,
  knownTransientEventEnvelopeSchema,
  parseThreadStreamFrame,
  parseThreadStreamFrameResultSchema,
  unknownEventEnvelopeSchema,
} from '@colorful-code/schema/events';
import { snapshotResetKindSchema } from '@colorful-code/schema/snapshot';

const occurredAt = '2026-07-17T10:30:00+08:00';
const THREAD_STREAM_FRAME_BUDGET = 16 * 1024 * 1024;
const THREAD_STREAM_FRAME_TOKEN_BUDGET = 250_000;

const unknownDurable = {
  eventId: 'event-unknown-durable',
  threadId: 'thread-1',
  kind: 'plugin.futureDurable',
  critical: false,
  occurredAt,
  runId: 'run-1',
  planGeneration: 2,
  payload: { nested: { value: 1 } },
  durability: 'durable',
  durableSequence: '9007199254740993',
  streamBasis: {
    incarnationId: 'incarnation-1',
    streamSequence: '9007199254740992',
  },
} as const;

const unknownTransient = {
  eventId: 'event-unknown-transient',
  threadId: 'thread-1',
  kind: 'plugin.futureTransient',
  critical: false,
  occurredAt,
  payload: ['future', { supported: true }],
  durability: 'transient',
  incarnationId: 'incarnation-1',
  streamSequence: '9007199254740994',
  durableBasis: '9007199254740993',
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
  kind: snapshotResetKindSchema.value,
  resetId: 'reset-1',
  threadId: 'thread-1',
  reason: 'runtimeNotLoaded',
  snapshot,
  durableCursor: '41',
} as const;

const expectProtocolError = (input: unknown) => {
  expect(parseThreadStreamFrame(input)).toEqual({
    outcome: 'protocolError',
    error: {
      code: 'VALIDATION_ERROR',
      message: 'Invalid thread stream frame',
      retryable: false,
    },
  });
};

describe('parseThreadStreamFrame unknown event compatibility', () => {
  test('preserves a non-critical unknown durable event and its cursor basis', () => {
    expect(parseThreadStreamFrame(unknownDurable)).toEqual({
      outcome: 'unknownNonCritical',
      frame: unknownDurable,
    });
  });

  test('preserves a non-critical unknown transient event and its cursors', () => {
    expect(parseThreadStreamFrame(unknownTransient)).toEqual({
      outcome: 'unknownNonCritical',
      frame: unknownTransient,
    });
  });

  test('requires unknown payloads to be JSON values', () => {
    for (const payload of [undefined, 1n, new Date(), { value: undefined }]) {
      expectProtocolError({ ...unknownDurable, payload });
    }

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expectProtocolError({ ...unknownDurable, payload: cyclic });
  });

  test('rejects a JSON frame beyond the parser budget without leaking details', () => {
    const result = parseThreadStreamFrame({
      ...unknownDurable,
      payload: 'x'.repeat(THREAD_STREAM_FRAME_BUDGET),
    });

    expect(result.outcome).toBe('protocolError');
    if (result.outcome !== 'protocolError') return;
    expect(result).toEqual({
      outcome: 'protocolError',
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Invalid thread stream frame',
        retryable: false,
      },
    });
    expect(parseThreadStreamFrameResultSchema.parse(result)).toEqual(result);
  });

  test('rejects a schema-valid low-byte frame beyond the token budget', () => {
    const frame = {
      ...unknownDurable,
      payload: new Array(THREAD_STREAM_FRAME_TOKEN_BUDGET + 1).fill(0),
    };

    expect(unknownEventEnvelopeSchema.safeParse(frame).success).toBe(true);
    expect(parseThreadStreamFrame(frame).outcome).toBe('protocolError');
  });

  test('keeps parser budgets isolated across successive calls', () => {
    const overComplexity = {
      ...unknownDurable,
      payload: new Array(THREAD_STREAM_FRAME_TOKEN_BUDGET + 1).fill(null),
    };

    expect(parseThreadStreamFrame(overComplexity).outcome).toBe(
      'protocolError',
    );
    expect(parseThreadStreamFrame(unknownDurable).outcome).toBe(
      'unknownNonCritical',
    );
    expect(parseThreadStreamFrame(unknownTransient).outcome).toBe(
      'unknownNonCritical',
    );
  });

  test('accepts and detaches a comfortably in-budget unknown frame', () => {
    const nested = { value: 'before' };
    const payload = {
      content: 'x'.repeat(1024 * 1024),
      nested,
    };
    const result = parseThreadStreamFrame({ ...unknownDurable, payload });

    expect(result.outcome).toBe('unknownNonCritical');
    if (result.outcome !== 'unknownNonCritical') return;
    expect(result.frame.payload).not.toBe(payload);
    nested.value = 'after';
    expect(result.frame.payload).toEqual({
      content: payload.content,
      nested: { value: 'before' },
    });
  });

  test('stops an oversized sparse container before enumerating its keys', () => {
    let ownKeysCalled = false;
    const sparsePayload = new Proxy(new Array(THREAD_STREAM_FRAME_BUDGET), {
      ownKeys: (target) => {
        ownKeysCalled = true;
        return Reflect.ownKeys(target);
      },
    });

    let outcome: ReturnType<typeof parseThreadStreamFrame>['outcome'] | null =
      null;
    expect(() => {
      outcome = parseThreadStreamFrame({
        ...unknownDurable,
        payload: sparsePayload,
      }).outcome;
    }).not.toThrow();
    expect(outcome).toBe('protocolError');
    expect(ownKeysCalled).toBe(false);
  });

  test('returns resetRequired without exposing a critical unknown frame', () => {
    expect(
      parseThreadStreamFrame({ ...unknownTransient, critical: true }),
    ).toEqual({
      outcome: 'resetRequired',
      reason: 'criticalUnknownEvent',
      eventId: unknownTransient.eventId,
      kind: unknownTransient.kind,
    });
  });

  test('does not let the unknown fallback swallow malformed known events', () => {
    expectProtocolError({
      ...unknownTransient,
      kind: 'assistant.textDelta',
      critical: true,
      payload: { wrong: 'shape' },
    });
  });

  test('keeps every published known kind excluded from the unknown branch', () => {
    const durableKinds = knownDurableEventEnvelopeSchema.options.map(
      (option) => option.shape.kind.value,
    );
    const transientKinds = knownTransientEventEnvelopeSchema.options.map(
      (option) => option.shape.kind.value,
    );

    for (const kind of durableKinds) {
      expectProtocolError({
        ...unknownDurable,
        kind,
        critical: true,
        payload: null,
      });
    }
    for (const kind of transientKinds) {
      expectProtocolError({
        ...unknownTransient,
        kind,
        critical: true,
        payload: null,
      });
    }
  });

  test('publishes the reserved kind exclusion in standard JSON Schema', () => {
    const schema = z.toJSONSchema(unknownEventEnvelopeSchema);
    const patterns: string[] = [];
    const pending: unknown[] = [schema];
    const visited = new Set<object>();

    while (pending.length > 0) {
      const value = pending.pop();
      if (value === null || typeof value !== 'object' || visited.has(value)) {
        continue;
      }
      visited.add(value);
      for (const [key, child] of Object.entries(value)) {
        if (key === 'pattern' && typeof child === 'string') {
          patterns.push(child);
        } else {
          pending.push(child);
        }
      }
    }

    const durableKinds = knownDurableEventEnvelopeSchema.options.map(
      (option) => option.shape.kind.value,
    );
    const transientKinds = knownTransientEventEnvelopeSchema.options.map(
      (option) => option.shape.kind.value,
    );
    const reservedKinds = [
      ...durableKinds,
      ...transientKinds,
      snapshotResetKindSchema.value,
    ];
    const exclusionPattern = patterns
      .map((pattern) => new RegExp(pattern))
      .find(
        (pattern) =>
          pattern.test('plugin.futureEvent') &&
          reservedKinds.every((kind) => !pattern.test(kind)),
      );

    expect(exclusionPattern).toBeDefined();
    for (const kind of reservedKinds) {
      expect(
        unknownEventEnvelopeSchema.safeParse({ ...unknownDurable, kind })
          .success,
      ).toBe(false);
    }
  });

  test('rejects edge whitespace without normalizing a valid unknown kind', () => {
    for (const kind of [
      ' plugin.futureDurable',
      'plugin.futureDurable ',
      '\tplugin.futureDurable',
      'plugin.futureDurable\n',
    ]) {
      expectProtocolError({ ...unknownDurable, kind });
    }

    const kind = 'plugin future:event/v2';
    expect(parseThreadStreamFrame({ ...unknownDurable, kind })).toEqual({
      outcome: 'unknownNonCritical',
      frame: { ...unknownDurable, kind },
    });
    expect(
      parseThreadStreamFrame({ ...unknownDurable, kind, critical: true }),
    ).toEqual({
      outcome: 'resetRequired',
      reason: 'criticalUnknownEvent',
      eventId: unknownDurable.eventId,
      kind,
    });
  });

  test('parses known events through the known branch even when critical', () => {
    const known = {
      ...unknownTransient,
      kind: 'assistant.textDelta',
      critical: true,
      payload: { transcriptItemId: 'transcript-1', chunk: 'hello' },
    } as const;

    expect(parseThreadStreamFrame(known)).toEqual({
      outcome: 'known',
      frame: known,
    });
  });

  test('parses SnapshotReset first and rejects a malformed reset as protocol error', () => {
    expect(parseThreadStreamFrame(snapshotReset)).toEqual({
      outcome: 'known',
      frame: snapshotReset,
    });
    expectProtocolError({ ...snapshotReset, durableCursor: '42' });
    expectProtocolError({
      ...unknownDurable,
      kind: snapshotResetKindSchema.value,
    });
  });

  test('keeps durable and transient unknown shapes strict and disjoint', () => {
    expectProtocolError({ ...unknownDurable, durableBasis: '1' });
    expectProtocolError({ ...unknownDurable, streamSequence: '1' });
    expectProtocolError({ ...unknownTransient, durableSequence: '1' });
    expectProtocolError({
      ...unknownTransient,
      streamBasis: { incarnationId: 'incarnation-1', streamSequence: '1' },
    });
    expectProtocolError({ ...unknownTransient, extra: true });
  });

  test('never throws for hostile containers, accessors, cycles, or primitives', () => {
    let getterCalled = false;
    const accessor = Object.defineProperty({}, 'kind', {
      enumerable: true,
      get: () => {
        getterCalled = true;
        throw new Error('must not invoke');
      },
    });
    const hostile = new Proxy(
      {},
      {
        getPrototypeOf: () => {
          throw new Error('hostile proxy');
        },
      },
    );
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    for (const input of [accessor, hostile, cyclic, null, 'frame', 1n]) {
      expect(() => parseThreadStreamFrame(input)).not.toThrow();
      expect(parseThreadStreamFrame(input).outcome).toBe('protocolError');
    }
    expect(getterCalled).toBe(false);
  });

  test('returns a detached payload snapshot and safely preserves __proto__', () => {
    const payload = Object.create(null) as Record<string, unknown>;
    const nested = { value: 1 };
    Object.defineProperty(payload, '__proto__', {
      value: { polluted: true },
      enumerable: true,
    });
    Object.defineProperty(payload, 'nested', {
      value: nested,
      enumerable: true,
    });
    const result = parseThreadStreamFrame({ ...unknownDurable, payload });

    expect(result.outcome).toBe('unknownNonCritical');
    if (result.outcome !== 'unknownNonCritical') return;
    expect(result.frame.payload).not.toBe(payload);
    expect(JSON.stringify(result.frame.payload)).toBe(
      '{"__proto__":{"polluted":true},"nested":{"value":1}}',
    );
    expect(Object.prototype).not.toHaveProperty('polluted');

    nested.value = 2;
    expect(JSON.stringify(result.frame.payload)).toBe(
      '{"__proto__":{"polluted":true},"nested":{"value":1}}',
    );
  });
});
