import { describe, expect, test } from 'bun:test';
import { z } from 'zod';

import {
  configRevisionSchema,
  durableCursorSchema,
  jsonValueSchema,
  pageCursorSchema,
  pageInfoSchema,
  pageSchema,
  planGenerationSchema,
  policyRevisionSchema,
  revisionSchema,
  streamCursorSchema,
  strictObjectSchema,
  timestampSchema,
} from '@colorful-code/schema/common';
import {
  approvalIdSchema,
  artifactIdSchema,
  checkpointIdSchema,
  commandIdSchema,
  contextBoundaryIdSchema,
  credentialRefIdSchema,
  daemonInstanceIdSchema,
  eventIdSchema,
  incarnationIdSchema,
  inputItemIdSchema,
  lineageIdSchema,
  operationIdSchema,
  pluginIdSchema,
  principalIdSchema,
  queueItemIdSchema,
  resetIdSchema,
  runIdSchema,
  threadIdSchema,
  toolExecutionIdSchema,
  transcriptItemIdSchema,
  workspaceIdSchema,
} from '@colorful-code/schema/ids';

const idSchemas = [
  threadIdSchema,
  lineageIdSchema,
  runIdSchema,
  queueItemIdSchema,
  inputItemIdSchema,
  transcriptItemIdSchema,
  operationIdSchema,
  approvalIdSchema,
  toolExecutionIdSchema,
  checkpointIdSchema,
  contextBoundaryIdSchema,
  eventIdSchema,
  resetIdSchema,
  incarnationIdSchema,
  commandIdSchema,
  credentialRefIdSchema,
  daemonInstanceIdSchema,
  artifactIdSchema,
  workspaceIdSchema,
  principalIdSchema,
  pluginIdSchema,
] as const;

describe('resource ID schemas', () => {
  test.each(idSchemas)('accepts opaque non-empty strings', (schema) => {
    expect(schema.parse('opaque-id')).toBe('opaque-id');
    expect(schema.parse(' opaque-id ')).toBe('opaque-id');
  });

  test.each(idSchemas)(
    'rejects empty and whitespace-only strings',
    (schema) => {
      expect(schema.safeParse('').success).toBe(false);
      expect(schema.safeParse('   ').success).toBe(false);
    },
  );
});

describe('timestampSchema', () => {
  test('accepts ISO-8601 datetimes with a timezone', () => {
    expect(timestampSchema.safeParse('2026-07-15T12:34:56Z').success).toBe(
      true,
    );
    expect(timestampSchema.safeParse('2026-07-15T20:34:56+08:00').success).toBe(
      true,
    );
  });

  test('rejects a datetime without a timezone', () => {
    expect(timestampSchema.safeParse('2026-07-15T12:34:56').success).toBe(
      false,
    );
  });

  test('rejects malformed and out-of-range datetimes', () => {
    for (const invalid of [
      'not-a-timestamp',
      '2026-13-15T12:34:56Z',
      '2026-02-30T12:34:56Z',
    ]) {
      expect(timestampSchema.safeParse(invalid).success).toBe(false);
    }
  });
});

describe('cursor schemas', () => {
  test.each([durableCursorSchema, streamCursorSchema, pageCursorSchema])(
    'accepts canonical unsigned decimal strings beyond safe integer range',
    (schema) => {
      expect(schema.safeParse('0').success).toBe(true);
      expect(schema.safeParse('9007199254740993').success).toBe(true);
    },
  );

  test.each([durableCursorSchema, streamCursorSchema, pageCursorSchema])(
    'rejects numbers and non-canonical decimal strings',
    (schema) => {
      for (const invalid of [1, '-1', '01', '1.5']) {
        expect(schema.safeParse(invalid).success).toBe(false);
      }
    },
  );
});

describe('revision and generation schemas', () => {
  test.each([
    revisionSchema,
    configRevisionSchema,
    policyRevisionSchema,
    planGenerationSchema,
  ])('accepts only non-negative safe integers', (schema) => {
    expect(schema.safeParse(0).success).toBe(true);
    expect(schema.safeParse(Number.MAX_SAFE_INTEGER).success).toBe(true);

    for (const invalid of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(schema.safeParse(invalid).success).toBe(false);
    }
  });
});

describe('jsonValueSchema', () => {
  test('accepts recursive JSON values', () => {
    const value = {
      null: null,
      boolean: true,
      number: 1.5,
      string: 'value',
      array: [null, false, { nested: ['json'] }],
    };

    expect(jsonValueSchema.parse(value)).toEqual(value);
  });

  test('rejects values that JSON cannot represent', () => {
    for (const invalid of [undefined, 1n, () => undefined, new Date(), /x/]) {
      expect(jsonValueSchema.safeParse(invalid).success).toBe(false);
    }
    expect(jsonValueSchema.safeParse({ nested: undefined }).success).toBe(
      false,
    );
  });
});

describe('pagination schemas', () => {
  test('strictObjectSchema preserves its shape and rejects unknown keys', () => {
    const schema = strictObjectSchema({ value: z.string() });

    expect(schema.parse({ value: 'ok' })).toEqual({ value: 'ok' });
    expect(schema.safeParse({ value: 'ok', extra: true }).success).toBe(false);
  });

  test('parses strict page info', () => {
    expect(
      pageInfoSchema.parse({ nextCursor: '9007199254740993', hasMore: true }),
    ).toEqual({ nextCursor: '9007199254740993', hasMore: true });
    expect(
      pageInfoSchema.safeParse({ nextCursor: null, hasMore: false }).success,
    ).toBe(true);
    expect(
      pageInfoSchema.safeParse({
        nextCursor: null,
        hasMore: false,
        extra: true,
      }).success,
    ).toBe(false);
  });

  test('creates a strict page schema for the supplied item schema', () => {
    const schema = pageSchema(z.string());
    const page = {
      items: ['one'],
      pageInfo: { nextCursor: null, hasMore: false },
    };

    expect(schema.parse(page)).toEqual(page);
    expect(schema.safeParse({ ...page, extra: true }).success).toBe(false);
    expect(schema.safeParse({ ...page, items: [1] }).success).toBe(false);
  });
});
