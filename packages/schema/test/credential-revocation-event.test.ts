import { describe, expect, test } from 'bun:test';

import { toContractJsonSchema } from '@colorful-code/schema';
import {
  credentialRevokedEventPayloadSchema,
  knownDurableEventEnvelopeSchema,
  knownDurableEventPayloadSchema,
  unknownDurableEventEnvelopeSchema,
} from '@colorful-code/schema/events';

const occurredAt = '2026-07-19T10:30:00+08:00';

const payload = {
  credentialRef: 'credential-store://provider/main',
  provider: 'example-provider',
  revokedAt: occurredAt,
  reason: 'rotated by operator',
} as const;

const envelope = {
  eventId: 'event-credential-revoked-1',
  threadId: 'thread-1',
  kind: 'credential.revoked',
  critical: true,
  occurredAt,
  durability: 'durable',
  durableSequence: '42',
  payload,
} as const;

describe('credential.revoked durable event', () => {
  test('publishes a strict canonical reference-only payload', () => {
    expect(knownDurableEventEnvelopeSchema.parse(envelope)).toEqual(envelope);

    const payloadOption = knownDurableEventPayloadSchema.options.find(
      (option) => option.shape.kind.value === 'credential.revoked',
    );
    expect(payloadOption).toBeDefined();
    const parsedPayload = payloadOption!.parse({
      kind: 'credential.revoked',
      payload,
    }).payload;
    expect(Object.keys(parsedPayload).sort()).toEqual(
      ['credentialRef', 'provider', 'reason', 'revokedAt'].sort(),
    );
  });

  test('rejects malformed metadata, timestamps, extra fields, and thread collections', () => {
    for (const invalidPayload of [
      { ...payload, credentialRef: '' },
      { ...payload, provider: '   ' },
      { ...payload, provider: ' example-provider ' },
      { ...payload, reason: '\t' },
      { ...payload, reason: ' rotated by operator ' },
      { ...payload, revokedAt: '2026-07-19T10:30:00' },
      { ...payload, secret: 'do-not-echo-canary' },
      { ...payload, value: 'do-not-echo-canary' },
      { ...payload, token: 'do-not-echo-canary' },
      { ...payload, affectedThreadIds: ['thread-1'] },
      { ...payload, threadIds: ['thread-1'] },
    ]) {
      expect(
        knownDurableEventEnvelopeSchema.safeParse({
          ...envelope,
          payload: invalidPayload,
        }).success,
      ).toBe(false);
    }
  });

  test('reserves credential.revoked from the unknown durable branch', () => {
    expect(
      unknownDurableEventEnvelopeSchema.safeParse({
        ...envelope,
        payload: null,
      }).success,
    ).toBe(false);
  });

  test('exports canonical provider and reason constraints to JSON Schema', () => {
    const jsonSchema = toContractJsonSchema(
      credentialRevokedEventPayloadSchema,
    ) as {
      properties?: {
        payload?: {
          properties?: {
            provider?: { pattern?: string };
            reason?: { pattern?: string };
          };
        };
      };
    };

    for (const field of ['provider', 'reason'] as const) {
      const pattern = new RegExp(
        jsonSchema.properties?.payload?.properties?.[field]?.pattern ?? '',
      );
      expect(pattern.test('canonical value')).toBe(true);
      expect(pattern.test(' padded value ')).toBe(false);
    }
  });
});
