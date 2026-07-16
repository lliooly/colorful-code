import { describe, expect, test } from 'bun:test';
import { z } from 'zod';

import {
  apiErrorSchema,
  errorCodeHttpStatus,
  errorCodeSchema,
  errorHttpMappingSchema,
  errorHttpMappings,
  type ErrorCode,
} from '@colorful-code/schema/errors';

const expectedHttpStatus = {
  VALIDATION_ERROR: 400,
  THREAD_NOT_FOUND: 404,
  THREAD_ARCHIVED: 422,
  THREAD_DELETED: 410,
  THREAD_PURGE_STARTED: 410,
  THREAD_NOT_IMMEDIATELY_RUNNABLE: 422,
  RUN_NOT_FOUND: 404,
  RUN_NOT_ACTIVE: 409,
  RUN_ALREADY_TERMINAL: 409,
  STALE_PLAN_GENERATION: 409,
  STALE_INCARNATION: 409,
  QUEUE_ITEM_NOT_FOUND: 404,
  QUEUE_ITEM_ALREADY_CONSUMED: 409,
  QUEUE_REVISION_CONFLICT: 409,
  COMMAND_ID_CONFLICT: 409,
  APPROVAL_EXPIRED: 409,
  OPERATION_CONFLICT: 409,
  CONFIG_REVISION_CONFLICT: 409,
  POLICY_REVISION_CONFLICT: 409,
  RUNTIME_DRAINING: 503,
  RECOVERY_BLOCKED: 503,
  INDETERMINATE_SIDE_EFFECT: 422,
  AUTHENTICATION_REQUIRED: 401,
  CREDENTIAL_UNAVAILABLE: 503,
  INTERNAL_ERROR: 500,
} as const satisfies Record<ErrorCode, number>;

const forbiddenAuthoringNodes = (schema: z.ZodType): string[] => {
  const forbidden: string[] = [];
  const seen = new Set<object>();

  const visit = (value: unknown, path: string): void => {
    if (value === null || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);

    const internals = value as {
      _zod?: { def?: Record<string, unknown> };
    };
    const definition = internals._zod?.def;
    if (definition !== undefined) {
      if (definition.type === 'transform' || definition.type === 'pipe') {
        forbidden.push(`${path}:${definition.type}`);
      }
      if (definition.check === 'custom') {
        forbidden.push(`${path}:${definition.check}`);
      }
      if (
        definition.type === 'lazy' &&
        typeof definition.getter === 'function'
      ) {
        visit(definition.getter(), `${path}.lazy()`);
      }
      visit(definition, `${path}.def`);
      return;
    }

    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${path}[${index}]`));
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      visit(child, `${path}.${key}`);
    }
  };

  visit(schema, 'apiErrorSchema');
  return forbidden;
};

describe('apiErrorSchema', () => {
  test('converts to JSON Schema with details as a JSON-valued object', () => {
    const jsonSchema = z.toJSONSchema(apiErrorSchema);
    const errorSchema = jsonSchema.properties?.error;
    expect(errorSchema).toBeObject();
    if (errorSchema === undefined || typeof errorSchema === 'boolean') return;
    const detailsSchema = errorSchema.properties?.details;

    expect(detailsSchema).toMatchObject({
      type: 'object',
      propertyNames: { type: 'string' },
    });
    if (detailsSchema === undefined || typeof detailsSchema === 'boolean')
      return;
    const additionalProperties = detailsSchema.additionalProperties;
    expect(additionalProperties).toMatchObject({
      $ref: expect.stringMatching(/^#\/\$defs\/[^/]+$/),
    });
    if (
      additionalProperties === undefined ||
      typeof additionalProperties === 'boolean' ||
      typeof additionalProperties.$ref !== 'string'
    ) {
      return;
    }
    const jsonValueRef = additionalProperties.$ref;
    const definitionKey = jsonValueRef.slice('#/$defs/'.length);

    expect(jsonSchema.$defs?.[definitionKey]).toEqual({
      anyOf: [
        { type: 'string' },
        { type: 'number' },
        { type: 'boolean' },
        { type: 'null' },
        {
          type: 'array',
          items: { $ref: jsonValueRef },
        },
        {
          type: 'object',
          propertyNames: { type: 'string' },
          additionalProperties: { $ref: jsonValueRef },
        },
      ],
    });
  });

  test('has no transform, pipe, or custom refine schema nodes', () => {
    expect(forbiddenAuthoringNodes(apiErrorSchema)).toEqual([]);
  });

  test('parses the strict public error envelope with authoritative IDs', () => {
    const value = {
      error: {
        code: 'OPERATION_CONFLICT',
        message: 'The operation conflicts with current state.',
        commandId: 'command-1',
        threadId: 'thread-1',
        runId: 'run-1',
        operationId: 'operation-1',
        retryable: false,
        details: {
          currentRevision: 3,
          expectedRevision: 2,
          context: { source: 'queue', active: true },
        },
      },
    };

    expect(apiErrorSchema.parse(value)).toEqual(value);
  });

  test('requires a non-empty public message and retryable flag', () => {
    const base = {
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Safe message',
        retryable: false,
      },
    };

    expect(apiErrorSchema.safeParse(base).success).toBe(true);
    expect(
      apiErrorSchema.safeParse({ error: { ...base.error, retryable: true } })
        .success,
    ).toBe(true);
    expect(
      apiErrorSchema.safeParse({ error: { ...base.error, message: '   ' } })
        .success,
    ).toBe(false);
    expect(
      apiErrorSchema.safeParse({
        error: { code: 'INTERNAL_ERROR', message: 'Safe message' },
      }).success,
    ).toBe(false);
  });

  test('rejects unknown envelope and nested error fields including internals', () => {
    const validError = {
      code: 'INTERNAL_ERROR',
      message: 'Safe message',
      retryable: false,
    } as const;

    for (const value of [
      { error: validError, requestId: 'request-1' },
      { error: { ...validError, unknown: true } },
      { error: { ...validError, stack: 'internal stack' } },
      { error: { ...validError, cause: 'database error' } },
      { error: { ...validError, secret: 'credential' } },
    ]) {
      expect(apiErrorSchema.safeParse(value).success).toBe(false);
    }
  });

  test('accepts details only when it is a JSON object', () => {
    const withDetails = (details: unknown) => ({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Invalid request',
        retryable: false,
        details,
      },
    });

    expect(
      apiErrorSchema.safeParse(
        withDetails({
          field: 'threadId',
          expectedRevision: 2,
          retryable: false,
          missing: null,
          path: ['error', 0, { nested: true }],
        }),
      ).success,
    ).toBe(true);
    for (const details of [
      null,
      [],
      'text',
      1,
      true,
      new Error('private failure'),
      new Date(),
      { nested: undefined },
      { nested: 1n },
    ]) {
      expect(apiErrorSchema.safeParse(withDetails(details)).success).toBe(
        false,
      );
    }
  });

  test('uses Zod authoring sanitization to drop a wire __proto__ key', () => {
    const details = JSON.parse(
      '{"__proto__":{"polluted":true},"stable":"preserved"}',
    ) as Record<string, unknown>;

    const parsed = apiErrorSchema.safeParse({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Invalid request',
        retryable: false,
        details,
      },
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    // Zod's object/record authoring sanitizer intentionally drops __proto__.
    expect(
      Object.prototype.hasOwnProperty.call(
        parsed.data.error.details,
        '__proto__',
      ),
    ).toBe(false);
    expect(parsed.data.error.details).toEqual({ stable: 'preserved' });
    expect('polluted' in parsed.data.error.details).toBe(false);
    expect(Object.getPrototypeOf(parsed.data.error.details)).toBe(
      Object.prototype,
    );
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  test('rejects blank authoritative IDs', () => {
    const base = {
      code: 'RUN_NOT_FOUND',
      message: 'Run not found',
      retryable: false,
    } as const;

    for (const id of [
      'commandId',
      'threadId',
      'runId',
      'operationId',
    ] as const) {
      expect(
        apiErrorSchema.safeParse({ error: { ...base, [id]: '   ' } }).success,
      ).toBe(false);
    }
  });
});

describe('error HTTP metadata', () => {
  test('maps all and only the 25 stable error codes to their fixed status', () => {
    expect(Object.keys(errorCodeHttpStatus)).toEqual(errorCodeSchema.options);
    expect(errorCodeHttpStatus).toEqual(expectedHttpStatus);
  });

  test('exposes a strict, complete metadata collection for documentation', () => {
    expect(errorHttpMappingSchema.parse(errorHttpMappings)).toEqual(
      errorHttpMappings,
    );
    expect(errorHttpMappings).toHaveLength(25);
    expect(errorHttpMappings.map(({ code }) => code)).toEqual(
      errorCodeSchema.options,
    );
    expect(
      Object.fromEntries(
        errorHttpMappings.map(({ code, httpStatus }) => [code, httpStatus]),
      ),
    ).toEqual(expectedHttpStatus);
    expect(
      errorHttpMappings.every(({ retryableDefault }) => !retryableDefault),
    ).toBe(true);
  });

  test('uses only stable categories derived from HTTP semantics', () => {
    const categoryForStatus = {
      400: 'validation',
      401: 'authentication',
      404: 'notFound',
      409: 'conflict',
      410: 'gone',
      422: 'semantic',
      503: 'unavailable',
      500: 'internal',
    } as const;

    for (const item of errorHttpMappings) {
      expect(item.category).toBe(categoryForStatus[item.httpStatus]);
    }
  });

  test('allows valid subsets and reordering while keeping entries strict', () => {
    const valid = errorHttpMappings.map((item) => ({ ...item }));

    expect(errorHttpMappingSchema.safeParse(valid.slice(1)).success).toBe(true);
    expect(
      errorHttpMappingSchema.safeParse([valid[1], valid[0], ...valid.slice(2)])
        .success,
    ).toBe(true);
  });

  test('rejects unknown values, incorrect types, and non-strict entries', () => {
    const valid = errorHttpMappings.map((item) => ({ ...item }));

    expect(
      errorHttpMappingSchema.safeParse([
        { ...valid[0], code: 'UNKNOWN_ERROR' },
        ...valid.slice(1),
      ]).success,
    ).toBe(false);
    expect(
      errorHttpMappingSchema.safeParse([
        { ...valid[0], httpStatus: 418 },
        ...valid.slice(1),
      ]).success,
    ).toBe(false);
    expect(
      errorHttpMappingSchema.safeParse([
        { ...valid[0], retryableDefault: 'false' },
        ...valid.slice(1),
      ]).success,
    ).toBe(false);
    expect(
      errorHttpMappingSchema.safeParse([
        { ...valid[0], category: 'other' },
        ...valid.slice(1),
      ]).success,
    ).toBe(false);
    expect(
      errorHttpMappingSchema.safeParse([
        { ...valid[0], description: 'extra' },
        ...valid.slice(1),
      ]).success,
    ).toBe(false);
  });

  test('deep-freezes all public HTTP metadata', () => {
    expect(Object.isFrozen(errorCodeHttpStatus)).toBe(true);
    expect(Object.isFrozen(errorHttpMappings)).toBe(true);
    for (const item of errorHttpMappings)
      expect(Object.isFrozen(item)).toBe(true);

    expect(() => {
      (errorCodeHttpStatus as Record<string, number>).INTERNAL_ERROR = 200;
    }).toThrow(TypeError);
    expect(() => {
      (
        errorHttpMappings as unknown as Array<{ httpStatus: number }>
      )[0]!.httpStatus = 200;
    }).toThrow(TypeError);
    expect(errorCodeHttpStatus.INTERNAL_ERROR).toBe(500);
    expect(errorHttpMappings[0]?.httpStatus).toBe(400);
  });
});
