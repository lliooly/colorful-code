import { describe, expect, test } from 'bun:test';
import { z } from 'zod';

import {
  configRevisionSchema,
  createBoundedJsonObjectSchema,
  createBoundedJsonValueSchema,
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

  test('returns ordinary objects without weakening prototype pollution defenses', () => {
    const input = JSON.parse(
      '{"value":1,"__proto__":{"polluted":true}}',
    ) as Record<string, unknown>;
    const parsed = jsonValueSchema.parse(input) as Record<string, unknown>;

    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
    expect(parsed.hasOwnProperty('value')).toBe(true);
    expect(parsed.toString()).toBe('[object Object]');
    expect(`${parsed}`).toBe('[object Object]');
    expect(Object.hasOwn(parsed, '__proto__')).toBe(true);
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

describe('createBoundedJsonValueSchema', () => {
  test('rejects invalid serialized-length budgets at construction', () => {
    for (const invalid of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => createBoundedJsonValueSchema(invalid)).toThrow(
        'Maximum serialized JSON length must be a non-negative safe integer',
      );
    }

    for (const invalid of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => createBoundedJsonValueSchema(100, invalid)).toThrow(
        'Maximum JSON token count must be a non-negative safe integer',
      );
    }
  });

  test('keeps invalid, over-length and over-complexity issues distinct', () => {
    const invalid = createBoundedJsonValueSchema(100, 10).safeParse(undefined);
    const overLength = createBoundedJsonValueSchema(0, 10).safeParse(null);
    const overComplexity = createBoundedJsonValueSchema(100, 0).safeParse(null);

    expect(invalid.success).toBe(false);
    expect(overLength.success).toBe(false);
    expect(overComplexity.success).toBe(false);
    if (!invalid.success && !overLength.success && !overComplexity.success) {
      expect(invalid.error.issues.map((issue) => issue.message)).toContain(
        'Expected a JSON value',
      );
      expect(overLength.error.issues.map((issue) => issue.message)).toContain(
        'JSON value exceeds the maximum serialized length',
      );
      expect(
        overComplexity.error.issues.map((issue) => issue.message),
      ).toContain('JSON value exceeds the maximum token count');
    }
  });

  test('rejects an object before ownKeys when braces exceed the budget', () => {
    let ownKeysCalls = 0;
    const observed = new Proxy(
      {},
      {
        ownKeys: (target) => {
          ownKeysCalls += 1;
          return Reflect.ownKeys(target);
        },
      },
    );

    expect(createBoundedJsonValueSchema(0).safeParse(observed).success).toBe(
      false,
    );
    expect(ownKeysCalls).toBe(0);
  });

  test('counts every JSON wire token at an exact serialized boundary', () => {
    const fixtures: Array<[unknown, number]> = [
      ['"', 4],
      ['\\', 4],
      ['\u0000\b\t\n\f\r\u001f', 24],
      ['\ud800', 8],
      ['你😀', 5],
      [-0, 1],
      [1e21, 5],
      [true, 4],
      [false, 5],
      [null, 4],
      [[], 2],
      [{}, 2],
      [{ ['"\\\n']: 0 }, 12],
      [[null, true, { a: 'b' }], 21],
    ];

    for (const [value, serializedLength] of fixtures) {
      expect(
        createBoundedJsonValueSchema(serializedLength).safeParse(value).success,
      ).toBe(true);
      const rejected = createBoundedJsonValueSchema(
        serializedLength - 1,
      ).safeParse(value);
      expect(rejected.success).toBe(false);
      if (!rejected.success) {
        expect(rejected.error.issues.map((issue) => issue.message)).toContain(
          'JSON value exceeds the maximum serialized length',
        );
      }
    }
  });

  test('counts primitive, container and key tokens at exact boundaries', () => {
    const fixtures: Array<[unknown, number]> = [
      [null, 1],
      [[], 1],
      [[null], 2],
      [{}, 1],
      [{ a: null }, 3],
      [{ a: [true] }, 4],
    ];

    for (const [value, tokenCount] of fixtures) {
      expect(
        createBoundedJsonValueSchema(1_000, tokenCount).safeParse(value)
          .success,
      ).toBe(true);
      expect(
        createBoundedJsonValueSchema(1_000, tokenCount - 1).safeParse(value)
          .success,
      ).toBe(false);
    }
  });

  test('prechecks dense arrays and objects before enumerating their values', () => {
    const arraySource = Array.from({ length: 100 }, () => null);
    let arrayOwnKeysCalls = 0;
    let arrayLengthDescriptorReads = 0;
    let arrayElementDescriptorReads = 0;
    const observedArray = new Proxy(arraySource, {
      ownKeys: (target) => {
        arrayOwnKeysCalls += 1;
        return Reflect.ownKeys(target);
      },
      getOwnPropertyDescriptor: (target, key) => {
        if (key === 'length') arrayLengthDescriptorReads += 1;
        else arrayElementDescriptorReads += 1;
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });

    const objectSource = Object.fromEntries(
      Array.from({ length: 100 }, (_, index) => [`key-${index}`, null]),
    );
    let objectOwnKeysCalls = 0;
    let objectDescriptorReads = 0;
    const observedObject = new Proxy(objectSource, {
      ownKeys: (target) => {
        objectOwnKeysCalls += 1;
        return Reflect.ownKeys(target);
      },
      getOwnPropertyDescriptor: (target, key) => {
        objectDescriptorReads += 1;
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });

    expect(
      createBoundedJsonValueSchema(10_000, 100).safeParse(observedArray)
        .success,
    ).toBe(false);
    expect(arrayLengthDescriptorReads).toBe(1);
    expect(arrayOwnKeysCalls).toBe(0);
    expect(arrayElementDescriptorReads).toBe(0);

    expect(
      createBoundedJsonValueSchema(10_000, 200).safeParse(observedObject)
        .success,
    ).toBe(false);
    expect(objectOwnKeysCalls).toBe(1);
    expect(objectDescriptorReads).toBe(0);

    expect(
      createBoundedJsonValueSchema(10_000).safeParse(arraySource).success,
    ).toBe(true);
  });

  test('counts a large escaped string without constructing a serialized copy', () => {
    const limit = 1_048_576;
    const escapedUnit = '"\\\n\ud800';
    const value = `${escapedUnit.repeat(87_381)}xx`;
    const schema = createBoundedJsonValueSchema(limit);

    expect(schema.safeParse(value).success).toBe(true);
    expect(schema.safeParse(`${value}x`).success).toBe(false);
  });

  test('stops reading wide container descriptors when the budget is exhausted', () => {
    const wideArraySource = Array.from({ length: 10_000 }, () => 'x');
    let arrayOwnKeysCalls = 0;
    let arrayLengthDescriptorReads = 0;
    let arrayElementDescriptorReads = 0;
    const wideArray = new Proxy(wideArraySource, {
      ownKeys: (target) => {
        arrayOwnKeysCalls += 1;
        return Reflect.ownKeys(target);
      },
      getOwnPropertyDescriptor: (target, key) => {
        if (key === 'length') {
          arrayLengthDescriptorReads += 1;
        } else {
          arrayElementDescriptorReads += 1;
        }
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });

    const wideObjectSource = Object.fromEntries(
      Array.from({ length: 10_000 }, (_, index) => [`key-${index}`, 'x']),
    );
    let objectDescriptorReads = 0;
    const wideObject = new Proxy(wideObjectSource, {
      getOwnPropertyDescriptor: (target, key) => {
        objectDescriptorReads += 1;
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });

    const schema = createBoundedJsonValueSchema(100);
    expect(schema.safeParse(wideArray).success).toBe(false);
    expect(schema.safeParse(wideObject).success).toBe(false);
    expect(arrayLengthDescriptorReads).toBe(1);
    expect(arrayOwnKeysCalls).toBe(0);
    expect(arrayElementDescriptorReads).toBe(0);
    expect(objectDescriptorReads).toBe(0);
  });

  test('returns a detached bounded snapshot', () => {
    const shared = ['before'];
    const source = { nested: shared, repeated: shared };
    const parsed = createBoundedJsonValueSchema(100, 7).parse(source);

    expect(parsed).not.toBe(source);
    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed)
    ) {
      throw new Error('expected an object JSON snapshot');
    }
    expect(parsed.nested).not.toBe(source.nested);
    expect(parsed.repeated).not.toBe(parsed.nested);

    source.nested[0] = 'after';
    expect(parsed).toEqual({ nested: ['before'], repeated: ['before'] });
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(
      createBoundedJsonValueSchema(100, 100).safeParse(cyclic).success,
    ).toBe(false);
    expect(() =>
      z.toJSONSchema(createBoundedJsonValueSchema(100)),
    ).not.toThrow();
  });
});

describe('createBoundedJsonObjectSchema', () => {
  test('bounds JSON objects iteratively while preserving object JSON Schema', () => {
    const schema = createBoundedJsonObjectSchema(100, 20);

    expect(schema.safeParse({ nested: { value: 1 } }).success).toBe(true);
    expect(schema.safeParse([]).success).toBe(false);
    expect(z.toJSONSchema(schema).type).toBe('object');
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
