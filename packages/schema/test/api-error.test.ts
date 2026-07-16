import { describe, expect, test } from 'bun:test';

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

describe('apiErrorSchema', () => {
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
      apiErrorSchema.safeParse(withDetails({ field: 'threadId' })).success,
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

  test('rejects cyclic details without throwing or overflowing the stack', () => {
    const details: Record<string, unknown> = {};
    details.self = details;
    const value = {
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Safe message',
        retryable: false,
        details,
      },
    };

    expect(() => apiErrorSchema.safeParse(value)).not.toThrow();
    expect(apiErrorSchema.safeParse(value).success).toBe(false);
  });

  test('rejects accessors and hostile proxies without invoking or leaking exceptions', () => {
    let getterInvoked = false;
    const throwingGetter = Object.defineProperty({}, 'value', {
      enumerable: true,
      get(): never {
        getterInvoked = true;
        throw new Error('getter must not run');
      },
    });
    const hostileProxy = new Proxy(
      {},
      {
        getPrototypeOf(): never {
          throw new Error('proxy trap');
        },
      },
    );
    const withDetails = (details: unknown) => ({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Safe message',
        retryable: false,
        details,
      },
    });

    for (const details of [throwingGetter, hostileProxy]) {
      expect(() =>
        apiErrorSchema.safeParse(withDetails(details)),
      ).not.toThrow();
      expect(apiErrorSchema.safeParse(withDetails(details)).success).toBe(
        false,
      );
    }
    expect(getterInvoked).toBe(false);
  });

  test('accepts a shared JSON subtree that is not cyclic', () => {
    const shared = { state: 'available' };
    const value = {
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Invalid request',
        retryable: false,
        details: { left: shared, right: shared },
      },
    };

    const parsed = apiErrorSchema.parse(value);

    expect(parsed.error.details?.left).toEqual(shared);
    expect(parsed.error.details?.right).toEqual(shared);
    expect(parsed.error.details?.left).not.toBe(shared);
    expect(parsed.error.details?.right).not.toBe(shared);
  });

  test('returns an isolated JSON snapshot that later input mutation cannot corrupt', () => {
    const details: Record<string, unknown> = {
      nested: { count: 1 },
      items: [{ state: 'ready' }],
    };
    const parsed = apiErrorSchema.parse({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Safe message',
        retryable: false,
        details,
      },
    });

    (details.nested as Record<string, unknown>).invalid = 1n;
    details.secret = 'added later';
    details.self = details;

    expect(parsed.error.details).toEqual({
      nested: { count: 1 },
      items: [{ state: 'ready' }],
    });
    expect(() => JSON.stringify(parsed)).not.toThrow();
  });

  test('snapshots descriptors without consulting a hostile value get trap', () => {
    const details = new Proxy(
      { stable: 'snapshot' },
      {
        get: () => 1n,
      },
    );

    const parsed = apiErrorSchema.safeParse({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Safe message',
        retryable: false,
        details,
      },
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.error.details).toEqual({ stable: 'snapshot' });
    expect(() => JSON.stringify(parsed.data)).not.toThrow();
  });

  test('normalizes an own __proto__ data key without prototype pollution', () => {
    const details = Object.defineProperty({}, '__proto__', {
      value: { polluted: true },
      enumerable: true,
      writable: true,
      configurable: true,
    });

    const parsed = apiErrorSchema.parse({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Invalid request',
        retryable: false,
        details,
      },
    });

    expect(
      Object.prototype.hasOwnProperty.call(parsed.error.details, '__proto__'),
    ).toBe(true);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
    expect(JSON.stringify(parsed.error.details)).toBe(
      '{"__proto__":{"polluted":true}}',
    );
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
