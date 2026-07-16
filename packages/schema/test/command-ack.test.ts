import { describe, expect, test } from 'bun:test';
import { z } from 'zod';

import * as ackContract from '@colorful-code/schema/ack';

const resultSchema = z.strictObject({
  kind: z.literal('queued'),
  position: z.number().int().nonnegative().safe(),
});

const canonicalAck = {
  commandId: 'command-1',
  operationId: 'operation-1',
  status: 'accepted',
  replayed: false,
  threadId: 'thread-1',
  runId: 'run-1',
  result: { kind: 'queued', position: 2 },
  completionEvents: ['operation.completed', 'operation.failed'],
  currentDurableCursor: '9007199254740993',
  acceptedAt: '2026-07-16T08:00:00Z',
} as const;

const synchronousAck = {
  commandId: canonicalAck.commandId,
  status: canonicalAck.status,
  replayed: canonicalAck.replayed,
  threadId: canonicalAck.threadId,
  runId: canonicalAck.runId,
  result: canonicalAck.result,
  currentDurableCursor: canonicalAck.currentDurableCursor,
  acceptedAt: canonicalAck.acceptedAt,
} as const;

describe('commandAckSchema', () => {
  test('parses synchronous and complete asynchronous Ack envelopes', () => {
    const schema = ackContract.commandAckSchema(resultSchema);
    const {
      result: _asynchronousResult,
      runId: _asynchronousRunId,
      ...asynchronousWithoutResultOrRunId
    } = canonicalAck;
    const { result: _synchronousResult, ...synchronousWithoutResult } =
      synchronousAck;

    expect(schema.parse(canonicalAck)).toEqual(canonicalAck);
    expect(schema.parse(synchronousAck)).toEqual(synchronousAck);
    expect(schema.parse(asynchronousWithoutResultOrRunId)).toEqual(
      asynchronousWithoutResultOrRunId,
    );
    expect(schema.parse(synchronousWithoutResult)).toEqual(
      synchronousWithoutResult,
    );
    expect(
      schema.safeParse({ ...canonicalAck, result: { kind: 'queued' } }).success,
    ).toBe(false);

    for (const required of [
      'commandId',
      'status',
      'replayed',
      'threadId',
      'currentDurableCursor',
      'acceptedAt',
    ] as const) {
      const candidate: Record<string, unknown> = { ...canonicalAck };
      delete candidate[required];
      expect(schema.safeParse(candidate).success).toBe(false);
    }
  });

  test('requires asynchronous metadata as one complete pair', () => {
    const schema = ackContract.commandAckSchema(resultSchema);

    expect(
      schema.safeParse({ ...synchronousAck, operationId: 'operation-1' })
        .success,
    ).toBe(false);
    expect(
      schema.safeParse({
        ...synchronousAck,
        completionEvents: ['operation.completed'],
      }).success,
    ).toBe(false);
    expect(schema.safeParse(canonicalAck).success).toBe(true);
    expect(
      schema.safeParse({ ...canonicalAck, completionEvents: [] }).success,
    ).toBe(false);
    expect(
      schema.safeParse({
        ...canonicalAck,
        completionEvents: ['queue.failed'],
      }).success,
    ).toBe(false);
  });

  test('omits result from the no-result schema instead of accepting any value', () => {
    const schema = ackContract.commandAckSchema();
    const { result: _result, ...asynchronousWithoutResult } = canonicalAck;
    const { result: _syncResult, ...synchronousWithoutResult } = synchronousAck;

    expect(schema.parse(asynchronousWithoutResult)).toEqual(
      asynchronousWithoutResult,
    );
    expect(schema.parse(synchronousWithoutResult)).toEqual(
      synchronousWithoutResult,
    );
    expect(schema.safeParse(canonicalAck).success).toBe(false);
    expect(schema.safeParse(synchronousAck).success).toBe(false);
  });

  test('rejects unknown fields, non-accepted statuses and non-canonical cursors', () => {
    const schema = ackContract.commandAckSchema(resultSchema);

    for (const invalid of [
      { ...canonicalAck, status: 'rejected' },
      { ...canonicalAck, currentDurableCursor: 9007199254740993 },
      { ...canonicalAck, currentDurableCursor: '09007199254740993' },
      { ...canonicalAck, clientIdentity: 'client-1' },
      { ...canonicalAck, payloadHash: 'sha256:example' },
      { ...canonicalAck, unknown: true },
    ]) {
      expect(schema.safeParse(invalid).success).toBe(false);
    }
  });

  test('parses original and replayed forms with one schema and preserves canonical fields', () => {
    const schema = ackContract.commandAckSchema(resultSchema);
    const original = schema.parse(canonicalAck);
    const replay = schema.parse({ ...canonicalAck, replayed: true });

    expect(original.replayed).toBe(false);
    expect(replay.replayed).toBe(true);
    expect({ ...original, replayed: true }).toEqual(replay);
    for (const field of [
      'commandId',
      'operationId',
      'result',
      'completionEvents',
      'currentDurableCursor',
      'acceptedAt',
    ] as const) {
      expect(replay[field]).toEqual(original[field]);
    }
  });

  test('publishes two strict JSON Schema branches without custom refinement', () => {
    const schema = ackContract.commandAckSchema(resultSchema);
    const jsonSchema = z.toJSONSchema(schema);

    expect(schema).toBeInstanceOf(z.ZodUnion);
    expect(jsonSchema.anyOf).toHaveLength(2);
    for (const branch of jsonSchema.anyOf ?? []) {
      expect(branch.type).toBe('object');
      expect(branch.additionalProperties).toBe(false);
    }

    const branches = jsonSchema.anyOf ?? [];
    const synchronousBranch = branches.find(
      (branch) => !branch.required?.includes('operationId'),
    );
    const asynchronousBranch = branches.find((branch) =>
      branch.required?.includes('operationId'),
    );

    expect(synchronousBranch).toBeDefined();
    expect(asynchronousBranch).toBeDefined();
    expect(synchronousBranch!.properties).not.toHaveProperty('operationId');
    expect(synchronousBranch!.properties).not.toHaveProperty(
      'completionEvents',
    );
    expect(asynchronousBranch!.required).toContain('completionEvents');
    expect(asynchronousBranch!.properties?.completionEvents).toMatchObject({
      minItems: 1,
    });
    expect(asynchronousBranch!.properties?.completionEvents?.items).toEqual({
      type: 'string',
      enum: ['operation.completed', 'operation.failed', 'operation.cancelled'],
    });
  });

  test('creates equivalent fresh schemas without publishing a replay wrapper', () => {
    const first = ackContract.commandAckSchema(resultSchema);
    const second = ackContract.commandAckSchema(resultSchema);

    expect(first).not.toBe(second);
    expect(first.options[0]).not.toBe(second.options[0]);
    expect(first.options[1]).not.toBe(second.options[1]);
    expect(first.parse(canonicalAck)).toEqual(second.parse(canonicalAck));
    expect('commandReplayResultSchema' in ackContract).toBe(false);
    expect('CommandReplayResult' in ackContract).toBe(false);
  });
});
