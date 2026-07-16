import { describe, expect, test } from 'bun:test';
import { z } from 'zod';

import {
  configRevisionSchema,
  durableCursorSchema,
  jsonObjectSchema,
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

const nestedObject = (containerCount: number): unknown => {
  let value: unknown = 'leaf';
  for (let index = 0; index < containerCount; index += 1) {
    value = { value };
  }
  return value;
};

const nestedArray = (containerCount: number): unknown => {
  let value: unknown = 'leaf';
  for (let index = 0; index < containerCount; index += 1) {
    value = [value];
  }
  return value;
};

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

    expect(z.toJSONSchema(schema).minimum).toBe(0);
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

  test('rejects cycles, accessors and hostile proxies without throwing', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const deeplyCyclic: Record<string, unknown> = {};
    let tail = deeplyCyclic;
    for (let depth = 0; depth < 15_000; depth += 1) {
      const next: Record<string, unknown> = {};
      tail.value = next;
      tail = next;
    }
    tail.value = deeplyCyclic;

    let getterCalled = false;
    const accessor = Object.defineProperty({}, 'secret', {
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
          throw new Error('hostile prototype trap');
        },
      },
    );

    for (const invalid of [cyclic, deeplyCyclic, accessor, hostile]) {
      expect(() => jsonValueSchema.safeParse(invalid)).not.toThrow();
      expect(jsonValueSchema.safeParse(invalid).success).toBe(false);
    }
    expect(getterCalled).toBe(false);
  });

  test('accepts deeply nested JSON without imposing an undocumented depth limit', () => {
    for (const pathological of [nestedObject(15_000), nestedArray(15_000)]) {
      expect(() => jsonValueSchema.safeParse(pathological)).not.toThrow();
      expect(jsonValueSchema.safeParse(pathological).success).toBe(true);
    }
    expect(() =>
      jsonObjectSchema.safeParse(nestedObject(15_000)),
    ).not.toThrow();
    expect(jsonObjectSchema.safeParse(nestedObject(15_000)).success).toBe(true);
  });

  test('allows shared subtrees and returns a detached deep snapshot', () => {
    const shared = { value: 1 };
    const input = { first: shared, second: shared, array: [shared] };
    const parsed = jsonValueSchema.parse(input);

    expect(JSON.stringify(parsed)).toBe(JSON.stringify(input));
    expect(parsed).not.toBe(input);
    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed)
    ) {
      throw new Error('expected object JSON snapshot');
    }
    expect(parsed.first).not.toBe(shared);
    expect(parsed.second).not.toBe(shared);
    expect(parsed.first).not.toBe(parsed.second);

    shared.value = 2;
    input.array.push({ value: 3 });
    expect(JSON.stringify(parsed)).toBe(
      '{"first":{"value":1},"second":{"value":1},"array":[{"value":1}]}',
    );
  });

  test('preserves an own __proto__ data key without prototype pollution', () => {
    const input = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(input, '__proto__', {
      value: { polluted: true },
      enumerable: true,
      writable: true,
      configurable: true,
    });

    const parsed = jsonValueSchema.parse(input);
    expect(JSON.stringify(parsed)).toBe('{"__proto__":{"polluted":true}}');
    expect(Object.prototype).not.toHaveProperty('polluted');
  });

  test('preserves prefixed, proto and nested object keys without collisions', () => {
    const nested = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(nested, '__proto__', {
      value: 'nested-proto',
      enumerable: true,
    });
    Object.defineProperty(nested, '\u0000__proto__', {
      value: 'nested-prefixed',
      enumerable: true,
    });

    const input = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(input, '\u0000__proto__', {
      value: 'prefixed',
      enumerable: true,
    });
    Object.defineProperty(input, '__proto__', {
      value: 'proto',
      enumerable: true,
    });
    Object.defineProperty(input, 'nested', {
      value: [{ object: nested }],
      enumerable: true,
    });

    expect(JSON.stringify(jsonValueSchema.parse(input))).toBe(
      '{"\\u0000__proto__":"prefixed","__proto__":"proto","nested":[{"object":{"__proto__":"nested-proto","\\u0000__proto__":"nested-prefixed"}}]}',
    );
    expect(Object.prototype).not.toHaveProperty('polluted');
  });

  test('exports recursive JSON-only and object-only JSON Schemas', () => {
    const valueJsonSchema = z.toJSONSchema(jsonValueSchema);
    const objectJsonSchema = z.toJSONSchema(jsonObjectSchema);
    const valueDefinition = Object.values(valueJsonSchema.$defs ?? {})[0] as
      | { anyOf?: Array<{ type?: string }> }
      | undefined;
    const valueTypes = new Set(
      valueDefinition?.anyOf?.map((branch) => branch.type),
    );

    expect(valueTypes).toEqual(
      new Set(['string', 'number', 'boolean', 'null', 'array', 'object']),
    );
    expect(valueDefinition?.anyOf).toHaveLength(6);
    expect(objectJsonSchema.type).toBe('object');
    expect(objectJsonSchema.additionalProperties).toBeDefined();
    expect(JSON.stringify(valueJsonSchema)).not.toBe(
      '{"$schema":"https://json-schema.org/draft/2020-12/schema"}',
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
