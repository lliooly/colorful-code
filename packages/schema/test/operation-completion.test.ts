import { describe, expect, test } from 'bun:test';
import { z } from 'zod';

import { operationKindSchema } from '@colorful-code/schema/enums';
import { errorCodeSchema } from '@colorful-code/schema/errors';
import {
  operationTerminalEventPayloadSchema,
  type OperationTerminalEventPayload,
} from '@colorful-code/schema/operations';

const at = '2026-07-16T09:30:00+08:00';

const common = (
  kind: (typeof operationKindSchema.options)[number],
  index: number,
) => ({
  operationId: 'operation-1',
  kind,
  runId: index % 2 === 0 ? null : 'run-1',
  revision: 4,
});

const terminalFixture = (
  kind: (typeof operationKindSchema.options)[number],
  status: OperationTerminalEventPayload['status'],
  index: number,
) => {
  switch (status) {
    case 'completed':
      return {
        ...common(kind, index),
        status,
        completedAt: at,
        result: { kind, values: [index, true, null] },
      };
    case 'failed':
      return {
        ...common(kind, index),
        status,
        error: {
          code: errorCodeSchema.options[index % errorCodeSchema.options.length],
          message: `failed ${kind}`,
          retryable: false,
          operationId: 'operation-1',
          details: { kind },
        },
      };
    case 'cancelled':
      return {
        ...common(kind, index),
        status,
        reason: `cancelled ${kind}`,
        cancelledAt: at,
        result: ['partial', index],
      };
  }
};

describe('operation terminal event payload', () => {
  test('parses all 12 operation kinds across all three terminal statuses', () => {
    const fixtures = operationKindSchema.options.flatMap((kind, index) =>
      (['completed', 'failed', 'cancelled'] as const).map((status) =>
        terminalFixture(kind, status, index),
      ),
    );

    expect(fixtures).toHaveLength(36);
    for (const fixture of fixtures) {
      expect(operationTerminalEventPayloadSchema.parse(fixture)).toEqual(
        fixture,
      );
    }
  });

  test('requires the nullable run fence and validates shared fields', () => {
    const valid = terminalFixture('steer', 'completed', 0);
    const { runId: _runId, ...missingRunId } = valid;

    for (const invalid of [
      missingRunId,
      { ...valid, operationId: '' },
      { ...valid, kind: 'unknown' },
      { ...valid, revision: -1 },
      { ...valid, revision: 1.5 },
    ]) {
      expect(
        operationTerminalEventPayloadSchema.safeParse(invalid).success,
      ).toBe(false);
    }
  });

  test('rejects non-terminal statuses, invalid branch fields and internals', () => {
    const completed = terminalFixture('stop', 'completed', 1);
    const failed = terminalFixture('stop', 'failed', 1);
    const cancelled = terminalFixture('stop', 'cancelled', 1);

    for (const invalid of [
      { ...completed, status: 'accepted' },
      { ...completed, status: 'executing' },
      { ...completed, status: 'waiting' },
      { ...completed, status: 'blocked' },
      { ...completed, completedAt: '2026-07-16' },
      { ...completed, result: 1n },
      { ...completed, error: failed.error },
      { ...failed, error: { ...failed.error, code: 'NOT_AN_ERROR_CODE' } },
      { ...failed, error: { ...failed.error, retryable: 'no' } },
      { ...failed, error: { ...failed.error, workerId: 'internal' } },
      { ...failed, failedAt: at },
      { ...failed, result: null },
      { ...cancelled, reason: '   ' },
      { ...cancelled, cancelledAt: 'soon' },
      { ...cancelled, result: Symbol('not-json') },
      { ...cancelled, workerId: 'internal' },
    ]) {
      expect(
        operationTerminalEventPayloadSchema.safeParse(invalid).success,
      ).toBe(false);
    }
  });

  test('rejects unsafe completed and cancelled results without throwing', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const hostile = new Proxy(
      {},
      {
        ownKeys: () => {
          throw new Error('hostile ownKeys trap');
        },
      },
    );

    for (const candidate of [
      { ...terminalFixture('steer', 'completed', 0), result: cyclic },
      { ...terminalFixture('stop', 'cancelled', 1), result: hostile },
    ]) {
      expect(() =>
        operationTerminalEventPayloadSchema.safeParse(candidate),
      ).not.toThrow();
      expect(
        operationTerminalEventPayloadSchema.safeParse(candidate).success,
      ).toBe(false);
    }
  });

  test('snapshots valid shared results into stringify-safe detached JSON', () => {
    const shared = { value: 1 };
    const result = { first: shared, second: shared };

    for (const candidate of [
      { ...terminalFixture('steer', 'completed', 0), result },
      { ...terminalFixture('stop', 'cancelled', 1), result },
    ]) {
      const parsed = operationTerminalEventPayloadSchema.parse(candidate);
      expect(() => JSON.stringify(parsed)).not.toThrow();
      expect(parsed.result).not.toBe(result);
      shared.value = 2;
      expect(JSON.stringify(parsed.result)).toBe(
        '{"first":{"value":1},"second":{"value":1}}',
      );
      shared.value = 1;
    }
  });

  test('exports structured JSON contracts for result and error details', () => {
    const generated = JSON.stringify(
      z.toJSONSchema(operationTerminalEventPayloadSchema),
    );

    expect(generated).toContain('"result"');
    expect(generated).toContain('"details"');
    expect(generated).toContain('"type":"array"');
    expect(generated).toContain('"type":"object"');
    expect(generated).not.toContain('"result":{}');
    expect(generated).not.toContain('"details":{}');
  });
});
