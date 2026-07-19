import { describe, expect, test } from 'bun:test';
import { z } from 'zod';

import type { JsonValue } from '@colorful-code/schema/common';
import {
  createDurableEventEnvelopeSchema,
  createEventPayloadSchema,
  createTransientEventEnvelopeSchema,
  knownDurableEventEnvelopeSchema,
  knownDurableEventPayloadSchema,
  knownTransientEventEnvelopeSchema,
  knownTransientEventPayloadSchema,
} from '@colorful-code/schema/events';

const occurredAt = '2026-07-17T10:30:00+08:00';

const thread = {
  threadId: 'thread-1',
  lineageId: 'lineage-1',
  parentThreadId: null,
  lifecycle: 'available',
  runtimeStatus: 'running',
  title: 'Envelope test',
  goal: null,
  workspaceBinding: {
    workspaceId: 'workspace-1',
    displayPath: '/workspace/project',
    trust: 'trusted',
  },
  activeRunId: 'run-1',
  threadRevision: 2,
  queueRevision: 3,
  configRevision: 4,
  policyRevision: 5,
  createdAt: occurredAt,
  updatedAt: occurredAt,
};

const run = {
  runId: 'run-1',
  threadId: 'thread-1',
  kind: 'interactive',
  status: 'running',
  sourceInputItemId: 'input-1',
  sourceQueueItemId: null,
  planGeneration: 1,
  configRevision: 4,
  policyRevision: 5,
  terminalReason: null,
  startedAt: occurredAt,
  endedAt: null,
  createdAt: occurredAt,
  updatedAt: occurredAt,
  revision: 2,
};

const queue = {
  threadId: 'thread-1',
  items: [],
  controlState: 'active',
  blockedByIndeterminate: false,
  effectiveState: 'active',
  revision: 3,
};

const approval = {
  approvalId: 'approval-1',
  threadId: 'thread-1',
  runId: 'run-1',
  kind: 'toolExecution',
  status: 'pending',
  planGeneration: 1,
  policyRevision: 5,
  requestSummary: { tool: 'shell' },
  decision: null,
  revision: 1,
  createdAt: occurredAt,
  updatedAt: occurredAt,
  decidedAt: null,
  expiresAt: null,
};

const operationCommon = {
  operationId: 'operation-1',
  kind: 'steer',
  runId: 'run-1',
  revision: 2,
};

const toolTerminal = {
  toolExecutionId: 'tool-execution-1',
  threadId: 'thread-1',
  runId: 'run-1',
  toolName: 'shell',
  state: 'completed',
  planGeneration: 1,
  policyRevision: 5,
  redactedSummary: { exitCode: 0 },
  artifacts: [],
  createdAt: occurredAt,
  updatedAt: occurredAt,
  completedAt: occurredAt,
};

const durablePayloads = {
  'thread.updated': thread,
  'thread.lifecycleChanged': { ...thread, lifecycle: 'archived' },
  'run.statusChanged': run,
  'queue.changed': queue,
  'operation.completed': {
    ...operationCommon,
    status: 'completed',
    completedAt: occurredAt,
    result: { applied: true },
  },
  'operation.failed': {
    ...operationCommon,
    status: 'failed',
    error: {
      code: 'OPERATION_CONFLICT',
      message: 'operation failed',
      retryable: false,
      operationId: 'operation-1',
    },
  },
  'operation.cancelled': {
    ...operationCommon,
    status: 'cancelled',
    reason: 'cancelled by user',
    cancelledAt: occurredAt,
  },
  'approval.requested': approval,
  'approval.resolved': {
    ...approval,
    status: 'approved',
    decision: { decision: 'approve' },
    decidedAt: occurredAt,
  },
  'approval.expired': { ...approval, status: 'expired' },
  'tool.terminal': toolTerminal,
  'credential.revoked': {
    credentialRef: 'credential-store://provider/main',
    provider: 'example-provider',
    revokedAt: occurredAt,
    reason: 'rotated by operator',
  },
} as const;

const durableBase = {
  eventId: 'event-1',
  threadId: 'thread-1',
  critical: false,
  occurredAt,
  runId: 'run-1',
  planGeneration: 1,
  durability: 'durable',
  durableSequence: '9007199254740993',
} as const;

const transientPayloads = {
  'assistant.textDelta': {
    transcriptItemId: 'transcript-1',
    chunk: ' hello ',
  },
  'assistant.reasoningDelta': {
    transcriptItemId: 'transcript-1',
    chunk: '\nreasoning\n',
  },
  'tool.stdoutDelta': {
    toolExecutionId: 'tool-execution-1',
    chunk: ' stdout ',
  },
  'tool.stderrDelta': {
    toolExecutionId: 'tool-execution-1',
    chunk: ' stderr ',
  },
  'operation.progressDelta': {
    operationId: 'operation-1',
    progress: { phase: 'copying', completedUnits: 2, totalUnits: 10 },
  },
} as const;

const transientBase = {
  eventId: 'event-2',
  threadId: 'thread-1',
  critical: false,
  occurredAt,
  runId: 'run-1',
  planGeneration: 1,
  durability: 'transient',
  incarnationId: 'incarnation-1',
  streamSequence: '9007199254740994',
  durableBasis: '9007199254740993',
} as const;

describe('known durable event envelopes', () => {
  test('locks the known kind set and parses each resource-backed payload', () => {
    const kinds = knownDurableEventPayloadSchema.options.map(
      (option) => option.shape.kind.value,
    );

    expect(kinds).toEqual(Object.keys(durablePayloads));

    for (const [kind, payload] of Object.entries(durablePayloads)) {
      const fixture = { ...durableBase, kind, payload };
      expect(knownDurableEventEnvelopeSchema.parse(fixture)).toEqual(fixture);
    }
  });

  test('requires the common base and keeps optional run fences optional', () => {
    const complete = {
      ...durableBase,
      kind: 'thread.updated',
      payload: thread,
    };
    const {
      runId: _runId,
      planGeneration: _generation,
      ...withoutFences
    } = complete;

    expect(knownDurableEventEnvelopeSchema.parse(withoutFences)).toEqual(
      withoutFences,
    );

    for (const field of [
      'eventId',
      'threadId',
      'kind',
      'critical',
      'occurredAt',
      'payload',
    ] as const) {
      const candidate: Record<string, unknown> = { ...complete };
      delete candidate[field];
      expect(knownDurableEventEnvelopeSchema.safeParse(candidate).success).toBe(
        false,
      );
    }
  });

  test('accepts a strict paired streamBasis and rejects transient cursor fields', () => {
    const fixture = {
      ...durableBase,
      kind: 'thread.updated',
      payload: thread,
    };

    expect(
      knownDurableEventEnvelopeSchema.safeParse({
        ...fixture,
        streamBasis: {
          incarnationId: 'incarnation-1',
          streamSequence: '42',
        },
      }).success,
    ).toBe(true);

    for (const invalid of [
      { ...fixture, incarnationId: 'incarnation-1' },
      { ...fixture, streamSequence: '1' },
      { ...fixture, durableBasis: '1' },
      { ...fixture, streamBasis: { incarnationId: 'incarnation-1' } },
      { ...fixture, streamBasis: { streamSequence: '1' } },
      {
        ...fixture,
        streamBasis: {
          incarnationId: 'incarnation-1',
          streamSequence: '1',
          extra: true,
        },
      },
    ]) {
      expect(knownDurableEventEnvelopeSchema.safeParse(invalid).success).toBe(
        false,
      );
    }
  });

  test('pins operation event kinds to their matching terminal status', () => {
    const completed = durablePayloads['operation.completed'];
    const failed = durablePayloads['operation.failed'];
    const cancelled = durablePayloads['operation.cancelled'];

    for (const [kind, payload] of [
      ['operation.completed', failed],
      ['operation.completed', cancelled],
      ['operation.failed', completed],
      ['operation.failed', cancelled],
      ['operation.cancelled', completed],
      ['operation.cancelled', failed],
    ]) {
      expect(
        knownDurableEventEnvelopeSchema.safeParse({
          ...durableBase,
          kind,
          payload,
        }).success,
      ).toBe(false);
    }
  });

  test('rejects non-canonical durable and stream basis cursors', () => {
    const fixture = {
      ...durableBase,
      kind: 'thread.updated',
      payload: thread,
    };

    for (const durableSequence of [1, '-1', '01', '1.0', ' 1']) {
      expect(
        knownDurableEventEnvelopeSchema.safeParse({
          ...fixture,
          durableSequence,
        }).success,
      ).toBe(false);
    }
    for (const streamSequence of [1, '-1', '01', '1.0', ' 1']) {
      expect(
        knownDurableEventEnvelopeSchema.safeParse({
          ...fixture,
          streamBasis: {
            incarnationId: 'incarnation-1',
            streamSequence,
          },
        }).success,
      ).toBe(false);
    }
  });
});

describe('known transient event envelopes', () => {
  test('locks the known kind set and preserves meaningful chunk whitespace', () => {
    const kinds = knownTransientEventPayloadSchema.options.map(
      (option) => option.shape.kind.value,
    );

    expect(kinds).toEqual(Object.keys(transientPayloads));

    for (const [kind, payload] of Object.entries(transientPayloads)) {
      const fixture = { ...transientBase, kind, payload };
      expect(knownTransientEventEnvelopeSchema.parse(fixture)).toEqual(fixture);
    }
  });

  test('requires its complete cursor space and rejects durable cursor fields', () => {
    const fixture = {
      ...transientBase,
      kind: 'assistant.textDelta',
      payload: transientPayloads['assistant.textDelta'],
    };

    for (const field of [
      'incarnationId',
      'streamSequence',
      'durableBasis',
    ] as const) {
      const candidate: Record<string, unknown> = { ...fixture };
      delete candidate[field];
      expect(
        knownTransientEventEnvelopeSchema.safeParse(candidate).success,
      ).toBe(false);
    }
    for (const invalid of [
      { ...fixture, durableSequence: '1' },
      {
        ...fixture,
        streamBasis: {
          incarnationId: 'incarnation-1',
          streamSequence: '1',
        },
      },
    ]) {
      expect(knownTransientEventEnvelopeSchema.safeParse(invalid).success).toBe(
        false,
      );
    }
  });

  test('rejects non-canonical transient cursors and bases', () => {
    const fixture = {
      ...transientBase,
      kind: 'assistant.textDelta',
      payload: transientPayloads['assistant.textDelta'],
    };

    for (const invalidCursor of [1, '-1', '01', '1.0', ' 1']) {
      expect(
        knownTransientEventEnvelopeSchema.safeParse({
          ...fixture,
          streamSequence: invalidCursor,
        }).success,
      ).toBe(false);
      expect(
        knownTransientEventEnvelopeSchema.safeParse({
          ...fixture,
          durableBasis: invalidCursor,
        }).success,
      ).toBe(false);
    }
  });

  test('bounds string chunks without exposing credential-shaped fields', () => {
    const fixture = {
      ...transientBase,
      kind: 'assistant.textDelta',
      payload: { transcriptItemId: 'transcript-1', chunk: 'x' },
    };

    expect(knownTransientEventEnvelopeSchema.safeParse(fixture).success).toBe(
      true,
    );
    for (const payload of [
      { transcriptItemId: 'transcript-1', chunk: '' },
      { transcriptItemId: 'transcript-1', chunk: 'x'.repeat(65_537) },
      {
        transcriptItemId: 'transcript-1',
        chunk: 'safe',
        secret: 'credential-material',
      },
      {
        transcriptItemId: 'transcript-1',
        chunk: 'safe',
        rawCredential: 'credential-material',
      },
    ]) {
      expect(
        knownTransientEventEnvelopeSchema.safeParse({
          ...fixture,
          payload,
        }).success,
      ).toBe(false);
    }
  });

  test('requires assistant deltas to identify their transcript item', () => {
    for (const kind of [
      'assistant.textDelta',
      'assistant.reasoningDelta',
    ] as const) {
      expect(
        knownTransientEventEnvelopeSchema.safeParse({
          ...transientBase,
          kind,
          payload: { chunk: 'delta' },
        }).success,
      ).toBe(false);
    }
  });
});

describe('event envelope factories', () => {
  test('build fresh isolated strict schemas without mutable registration', () => {
    const alphaPayload = createEventPayloadSchema(
      'example.alpha',
      z.strictObject({ value: z.string() }),
    );
    const betaPayload = createEventPayloadSchema(
      'example.beta',
      z.strictObject({ count: z.number().int() }),
    );
    const alphaFirst = createDurableEventEnvelopeSchema(alphaPayload);
    const beta = createDurableEventEnvelopeSchema(betaPayload);
    const alphaSecond = createDurableEventEnvelopeSchema(alphaPayload);
    const transient = createTransientEventEnvelopeSchema(alphaPayload);
    const alphaFixture = {
      ...durableBase,
      kind: 'example.alpha',
      payload: { value: 'a' },
    };

    expect(alphaFirst).not.toBe(alphaSecond);
    expect(alphaFirst.parse(alphaFixture)).toEqual(alphaFixture);
    expect(alphaSecond.parse(alphaFixture)).toEqual(alphaFixture);
    expect(beta.safeParse(alphaFixture).success).toBe(false);
    expect(
      transient.safeParse({
        ...transientBase,
        kind: 'example.alpha',
        payload: { value: 'a' },
      }).success,
    ).toBe(true);
    expect(
      alphaFirst.safeParse({ ...alphaFixture, payload: { value: 'a', x: 1 } })
        .success,
    ).toBe(false);
  });

  test('does not widen the envelope from foreign top-level payload metadata', () => {
    const foreignPayloadSchema = z.strictObject({
      kind: z.literal('example.foreign'),
      payload: z.strictObject({ value: z.string() }),
      workerId: z.string(),
    });
    const envelopeSchema =
      createDurableEventEnvelopeSchema(foreignPayloadSchema);

    expect(
      envelopeSchema.safeParse({
        ...durableBase,
        kind: 'example.foreign',
        payload: { value: 'safe' },
        workerId: 'internal-worker',
      }).success,
    ).toBe(false);
  });

  test('keeps payload required and constrained to JSON wire values', () => {
    const optionalPayload = createEventPayloadSchema(
      'example.optional',
      z.string().optional(),
    );
    const optionalEnvelope = createDurableEventEnvelopeSchema(optionalPayload);
    expect(
      optionalEnvelope.safeParse({
        ...durableBase,
        kind: 'example.optional',
      }).success,
    ).toBe(false);
    expect(
      optionalEnvelope.safeParse({
        ...durableBase,
        kind: 'example.optional',
        payload: 'present',
      }).success,
    ).toBe(true);
    expect(() =>
      createEventPayloadSchema('example.undefined', z.undefined()),
    ).toThrow('Event payload schema must describe JSON wire values');
    expect(() => createEventPayloadSchema('example.date', z.date())).toThrow(
      'Event payload schema must describe JSON wire values',
    );

    const optionalEnvelopePayload = z.strictObject({
      kind: z.literal('example.optional-direct'),
      payload: z.string().optional(),
    });
    const directEnvelope = createDurableEventEnvelopeSchema(
      optionalEnvelopePayload,
    );
    expect(
      directEnvelope.safeParse({
        ...durableBase,
        kind: 'example.optional-direct',
      }).success,
    ).toBe(false);
  });

  test('rejects blank and multi-value event kind declarations', () => {
    const multiKindPayload = z.strictObject({
      kind: z.literal(['example.alpha', 'example.beta']),
      payload: z.strictObject({ value: z.string() }),
    });

    expect(() =>
      createEventPayloadSchema('   ', z.strictObject({ value: z.string() })),
    ).toThrow('Event kind must be a non-empty string');
    expect(() => createDurableEventEnvelopeSchema(multiKindPayload)).toThrow(
      'Event kind must be one non-empty string literal',
    );
  });

  test('keeps generated JSON Schema payload definitions specific', () => {
    const generated = JSON.stringify(
      z.toJSONSchema(knownDurableEventEnvelopeSchema),
    );

    expect(generated).toContain('threadRevision');
    expect(generated).toContain('operationId');
    expect(generated).toContain('additionalProperties');
  });

  test('rejects non-JSON values even when a permissive payload schema accepts them', () => {
    const permissivePayload = createEventPayloadSchema(
      'example.permissive',
      z.any().nonoptional(),
    );
    const envelope = createDurableEventEnvelopeSchema(permissivePayload);
    const fixture = {
      ...durableBase,
      kind: 'example.permissive',
      payload: { nested: ['valid', 1, true, null] },
    };

    const parsedPayload: JsonValue = envelope.parse(fixture).payload;
    expect(parsedPayload).toEqual(fixture.payload);
    for (const payload of [
      new Date(0),
      () => 'function',
      Symbol('symbol'),
      new Map([['key', 'value']]),
    ]) {
      expect(envelope.safeParse({ ...fixture, payload }).success).toBe(false);
    }
    expect(envelope.safeParse({ ...fixture, payload: undefined }).success).toBe(
      false,
    );
  });

  test('does not execute synchronous payload refinements during construction', () => {
    let calls = 0;
    const payload = createEventPayloadSchema(
      'example.refined',
      z
        .any()
        .refine(() => {
          calls += 1;
          return true;
        })
        .nonoptional(),
    );

    const envelope = createDurableEventEnvelopeSchema(payload);
    expect(calls).toBe(0);
    expect(
      envelope.safeParse({
        ...durableBase,
        kind: 'example.refined',
        payload: 'value',
      }).success,
    ).toBe(true);
    expect(calls).toBe(1);
  });

  test('does not start asynchronous payload refinements during construction', () => {
    let calls = 0;
    const asyncSchema = z
      .any()
      .refine(async () => {
        calls += 1;
        return true;
      })
      .nonoptional();

    expect(() => {
      const payload = createEventPayloadSchema(
        'example.async-refined',
        asyncSchema,
      );
      createTransientEventEnvelopeSchema(payload);
    }).not.toThrow();
    expect(calls).toBe(0);
  });

  test('returns a detached JSON snapshot instead of aliasing permissive input', () => {
    const permissivePayload = createEventPayloadSchema(
      'example.detached',
      z.any().nonoptional(),
    );
    const envelope = createDurableEventEnvelopeSchema(permissivePayload);
    const source: Record<string, unknown> = {
      nested: { text: 'original', items: ['first'] },
    };
    const parsed = envelope.parse({
      ...durableBase,
      kind: 'example.detached',
      payload: source,
    });
    const parsedPayload = parsed.payload as Record<string, JsonValue>;
    const parsedNested = parsedPayload.nested as Record<string, JsonValue>;

    expect(parsedPayload).not.toBe(source);
    expect(parsedNested).not.toBe(source.nested);

    const sourceNested = source.nested as Record<string, unknown>;
    sourceNested.text = 'mutated';
    (sourceNested.items as unknown[]).push('second');
    sourceNested.injected = () => 'not-json';
    source.self = source;

    expect(parsedPayload).toEqual({
      nested: { text: 'original', items: ['first'] },
    });
    expect(() => JSON.stringify(parsedPayload)).not.toThrow();
  });

  test('preserves a detached own __proto__ JSON data key', () => {
    const permissivePayload = createEventPayloadSchema(
      'example.proto-data',
      z.any().nonoptional(),
    );
    const envelope = createTransientEventEnvelopeSchema(permissivePayload);
    const source = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(source, '__proto__', {
      value: { safe: true },
      enumerable: true,
      writable: true,
      configurable: true,
    });

    const parsed = envelope.parse({
      ...transientBase,
      kind: 'example.proto-data',
      payload: source,
    });
    const parsedPayload = parsed.payload as Record<string, JsonValue>;

    expect(parsedPayload).not.toBe(source);
    expect(
      Object.prototype.hasOwnProperty.call(parsedPayload, '__proto__'),
    ).toBe(true);
    expect(parsedPayload.__proto__).toEqual({ safe: true });
    (source.__proto__ as Record<string, unknown>).safe = false;
    expect(parsedPayload.__proto__).toEqual({ safe: true });
    expect(() => JSON.stringify(parsedPayload)).not.toThrow();
  });
});
