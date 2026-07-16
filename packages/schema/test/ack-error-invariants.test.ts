import { describe, expect, test } from 'bun:test';
import { z } from 'zod';

import { commandAckSchema } from '@colorful-code/schema/ack';
import {
  httpContractRegistry,
  type HttpContractDescriptor,
} from '@colorful-code/schema/commands';
import {
  apiErrorSchema,
  errorCodeHttpStatus,
  errorHttpMappingSchema,
  errorHttpMappings,
} from '@colorful-code/schema/errors';
import { operationTerminalEventPayloadSchema } from '@colorful-code/schema/operations';

const acceptedAck = {
  commandId: 'command-1',
  operationId: 'operation-1',
  status: 'accepted',
  replayed: false,
  threadId: 'thread-1',
  runId: 'run-1',
  completionEvents: ['operation.completed'],
  currentDurableCursor: '42',
  acceptedAt: '2026-07-16T08:00:00Z',
} as const;

const publicError = {
  code: 'INTERNAL_ERROR',
  message: 'A safe public message',
  retryable: false,
} as const;

const completedOperation = {
  operationId: 'operation-1',
  kind: 'stop',
  runId: 'run-1',
  revision: 3,
  status: 'completed',
  completedAt: '2026-07-16T08:01:00Z',
  result: { stopped: true },
} as const;

const endpoint = (operationId: string): HttpContractDescriptor => {
  const descriptor = (
    httpContractRegistry as Readonly<
      Record<string, HttpContractDescriptor | undefined>
    >
  )[operationId];
  if (descriptor === undefined) throw new Error(`missing ${operationId}`);
  return descriptor;
};

describe('negative public envelope invariants', () => {
  test('keeps CommandAck acceptance-only and unable to imply terminal completion', () => {
    const schema = commandAckSchema();
    const { operationId: _operationId, ...withoutOperationId } = acceptedAck;

    expect(schema.parse(withoutOperationId)).toEqual(withoutOperationId);
    for (const candidate of [
      { ...acceptedAck, status: 'rejected' },
      { ...acceptedAck, status: 'error' },
      { ...acceptedAck, clientIdentity: 'client-1' },
      { ...acceptedAck, payloadHash: 'sha256:private' },
      { ...acceptedAck, secret: 'private' },
      { ...acceptedAck, unknown: true },
      { ...acceptedAck, completedAt: '2026-07-16T08:01:00Z' },
      { ...acceptedAck, cancelledAt: '2026-07-16T08:01:00Z' },
      { ...acceptedAck, result: { terminal: true } },
    ]) {
      expect(schema.safeParse(candidate).success).toBe(false);
    }
  });

  test('keeps ApiError envelope and payload free of internals', () => {
    for (const candidate of [
      { error: publicError, stack: 'envelope stack' },
      { error: publicError, cause: 'envelope cause' },
      { error: publicError, secret: 'envelope secret' },
      { error: publicError, unknown: true },
      { error: { ...publicError, stack: 'payload stack' } },
      { error: { ...publicError, cause: 'payload cause' } },
      { error: { ...publicError, secret: 'payload secret' } },
      { error: { ...publicError, unknown: true } },
    ]) {
      expect(apiErrorSchema.safeParse(candidate).success).toBe(false);
    }
  });

  test('fails safely for non-JSON and cyclic details at arbitrary depth', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    let excessivelyDeep: Record<string, unknown> = {};
    for (let depth = 0; depth < 110; depth += 1) {
      excessivelyDeep = { nested: excessivelyDeep };
    }
    const withDetails = (details: unknown) => ({
      error: { ...publicError, details },
    });

    for (const details of [
      1n,
      Symbol('private'),
      new Date(),
      { value: Number.NaN },
      { value: undefined },
      cyclic,
    ]) {
      const candidate = withDetails(details);
      expect(() => apiErrorSchema.safeParse(candidate)).not.toThrow();
      expect(apiErrorSchema.safeParse(candidate).success).toBe(false);
    }

    expect(() =>
      apiErrorSchema.safeParse(withDetails(excessivelyDeep)),
    ).not.toThrow();
    expect(apiErrorSchema.safeParse(withDetails(excessivelyDeep)).success).toBe(
      true,
    );
  });

  test('accepts only terminal operation statuses and rejects internal fields', () => {
    for (const candidate of [
      { ...completedOperation, status: 'accepted' },
      { ...completedOperation, status: 'executing' },
      { ...completedOperation, status: 'waiting' },
      { ...completedOperation, status: 'blocked' },
      { ...completedOperation, workerId: 'worker-1' },
      { ...completedOperation, leaseToken: 'lease-secret' },
      { ...completedOperation, attempt: 2 },
      { ...completedOperation, internalState: 'committed' },
    ]) {
      expect(
        operationTerminalEventPayloadSchema.safeParse(candidate).success,
      ).toBe(false);
    }
  });
});

describe('schema construction and parse isolation invariants', () => {
  test('creates independent equivalent Ack schemas under interleaved construction', () => {
    const resultSchema = z.strictObject({ value: z.string() });
    const first = commandAckSchema(resultSchema);
    const unrelated = commandAckSchema(z.strictObject({ count: z.number() }));
    const second = commandAckSchema(resultSchema);

    expect(first).not.toBe(second);
    expect(first.shape).not.toBe(second.shape);
    expect(first.shape).not.toBe(unrelated.shape);
    expect(
      first.parse({ ...acceptedAck, result: { value: 'stable' } }),
    ).toEqual(second.parse({ ...acceptedAck, result: { value: 'stable' } }));
  });

  test('keeps original, replay, and distinct result schemas isolated across interleaved parses', () => {
    const noResult = commandAckSchema();
    const textResult = commandAckSchema(
      z.strictObject({ kind: z.literal('text'), value: z.string() }),
    );
    const countResult = commandAckSchema(
      z.strictObject({ kind: z.literal('count'), value: z.number().int() }),
    );

    const outcomes = [
      noResult.safeParse(acceptedAck),
      textResult.safeParse({
        ...acceptedAck,
        result: { kind: 'text', value: 'one' },
      }),
      noResult.safeParse({ ...acceptedAck, replayed: true }),
      countResult.safeParse({
        ...acceptedAck,
        replayed: true,
        result: { kind: 'count', value: 2 },
      }),
      textResult.safeParse({
        ...acceptedAck,
        replayed: true,
        result: { kind: 'text', value: 'two' },
      }),
      noResult.safeParse(acceptedAck),
    ];

    expect(outcomes.every(({ success }) => success)).toBe(true);
    expect(
      noResult.safeParse({ ...acceptedAck, result: { kind: 'text' } }).success,
    ).toBe(false);
    expect(
      textResult.safeParse({
        ...acceptedAck,
        result: { kind: 'count', value: 2 },
      }).success,
    ).toBe(false);
    expect(
      countResult.safeParse({
        ...acceptedAck,
        result: { kind: 'text', value: 'one' },
      }).success,
    ).toBe(false);
  });
});

describe('immutable synchronous metadata invariants', () => {
  test('resists HTTP metadata mutation without affecting later parses', () => {
    const canonicalMappings = errorHttpMappings.map((mapping) => ({
      ...mapping,
    }));

    expect(Object.isFrozen(errorCodeHttpStatus)).toBe(true);
    expect(Object.isFrozen(errorHttpMappings)).toBe(true);
    expect(errorHttpMappings.every(Object.isFrozen)).toBe(true);
    expect(() => {
      (errorCodeHttpStatus as Record<string, number>).INTERNAL_ERROR = 200;
    }).toThrow(TypeError);
    expect(() => {
      (
        errorHttpMappings as unknown as Array<{ httpStatus: number }>
      )[0]!.httpStatus = 200;
    }).toThrow(TypeError);

    expect(errorCodeHttpStatus.INTERNAL_ERROR).toBe(500);
    expect(errorHttpMappingSchema.parse(errorHttpMappings)).toEqual(
      canonicalMappings,
    );
    expect(apiErrorSchema.parse({ error: publicError })).toEqual({
      error: publicError,
    });
  });

  test('exposes only eagerly constructed frozen registry metadata', () => {
    const initialEntries = Object.entries(httpContractRegistry);
    const initialEntryCount = initialEntries.length;
    const operationIds = new Set<string>();

    expect(Object.isFrozen(httpContractRegistry)).toBe(true);
    expect(initialEntryCount).toBeGreaterThan(0);
    for (const [registryKey, descriptor] of initialEntries) {
      expect(Object.isFrozen(descriptor)).toBe(true);
      expect(descriptor.operationId).toBe(registryKey);
      expect(operationIds.has(descriptor.operationId)).toBe(false);
      operationIds.add(descriptor.operationId);
      expect(
        Object.values(descriptor).some(
          (value) => typeof value === 'function' || value instanceof Promise,
        ),
      ).toBe(false);
    }

    expect(operationIds.size).toBe(initialEntryCount);
    expect(Object.keys(httpContractRegistry)).toHaveLength(initialEntryCount);
  });

  test('rejects registry mutation and preserves subsequent Ack parsing', () => {
    const descriptor = endpoint('checkpoint.apply');
    expect(() => {
      (httpContractRegistry as Record<string, unknown>)['duplicate.route'] = {};
    }).toThrow(TypeError);
    expect(() => {
      (descriptor as unknown as { path: string }).path = '/internal';
    }).toThrow(TypeError);

    expect(endpoint('checkpoint.apply')).toBe(descriptor);
    expect(descriptor.path).toBe(
      '/v2/threads/{threadId}/checkpoints/{checkpointId}/apply',
    );
    expect(descriptor.resultSchema.parse(acceptedAck)).toEqual(acceptedAck);
  });
});
