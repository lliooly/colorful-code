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
  completionEvents: ['queue.applied', 'queue.failed'],
  currentDurableCursor: '9007199254740993',
  acceptedAt: '2026-07-16T08:00:00Z',
} as const;

describe('commandAckSchema', () => {
  test('parses the exact accepted Ack envelope with an optional result', () => {
    const schema = ackContract.commandAckSchema(resultSchema);

    expect(schema.parse(canonicalAck)).toEqual(canonicalAck);
    const { result: _result, ...withoutResult } = canonicalAck;
    expect(schema.parse(withoutResult)).toEqual(withoutResult);
    expect(
      schema.parse({
        commandId: canonicalAck.commandId,
        status: canonicalAck.status,
        replayed: canonicalAck.replayed,
        threadId: canonicalAck.threadId,
        currentDurableCursor: canonicalAck.currentDurableCursor,
        acceptedAt: canonicalAck.acceptedAt,
      }),
    ).toEqual({
      commandId: canonicalAck.commandId,
      status: canonicalAck.status,
      replayed: canonicalAck.replayed,
      threadId: canonicalAck.threadId,
      currentDurableCursor: canonicalAck.currentDurableCursor,
      acceptedAt: canonicalAck.acceptedAt,
    });
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

  test('omits result from the no-result schema instead of accepting any value', () => {
    const schema = ackContract.commandAckSchema();
    const { result: _result, ...withoutResult } = canonicalAck;

    expect(schema.parse(withoutResult)).toEqual(withoutResult);
    expect(schema.safeParse(canonicalAck).success).toBe(false);
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

  test('creates equivalent fresh schemas without publishing a replay wrapper', () => {
    const first = ackContract.commandAckSchema(resultSchema);
    const second = ackContract.commandAckSchema(resultSchema);

    expect(first).not.toBe(second);
    expect(first.parse(canonicalAck)).toEqual(second.parse(canonicalAck));
    expect('commandReplayResultSchema' in ackContract).toBe(false);
    expect('CommandReplayResult' in ackContract).toBe(false);
  });
});
