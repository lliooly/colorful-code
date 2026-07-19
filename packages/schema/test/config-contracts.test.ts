import { describe, expect, test } from 'bun:test';

import { toContractJsonSchema } from '@colorful-code/schema';
import {
  configPatchSchema,
  credentialRefSchema,
} from '@colorful-code/schema/config';

const credentialRef = {
  credentialRef: 'credential-store://colorful-code/provider',
  provider: 'openai',
  label: 'Work account',
  createdAt: '2026-07-19T08:00:00Z',
};

describe('credential reference contract', () => {
  test('accepts exactly reference metadata without credential material', () => {
    expect(credentialRefSchema.parse(credentialRef)).toEqual(credentialRef);
    expect(Object.keys(credentialRefSchema.shape).sort()).toEqual(
      ['createdAt', 'credentialRef', 'label', 'provider'].sort(),
    );
  });

  test('rejects malformed metadata and every explicit credential-value field', () => {
    for (const invalid of [
      { ...credentialRef, credentialRef: '' },
      { ...credentialRef, provider: '   ' },
      { ...credentialRef, provider: ' openai ' },
      { ...credentialRef, label: '   ' },
      { ...credentialRef, label: ' Work account ' },
      { ...credentialRef, createdAt: '2026-07-19T08:00:00' },
    ]) {
      expect(credentialRefSchema.safeParse(invalid).success).toBe(false);
    }

    for (const key of [
      'value',
      'token',
      'apiKey',
      'password',
      'headers',
      'secret',
      'serializedCredential',
    ]) {
      expect(
        credentialRefSchema.safeParse({
          ...credentialRef,
          [key]: 'rejected-canary-value',
        }).success,
      ).toBe(false);
    }
  });
});

describe('config patch contract', () => {
  test('accepts only the documented fields and requires at least one', () => {
    const patch = {
      model: 'gpt-5',
      provider: 'openai',
      providerCredentialRef: 'credential-store://colorful-code/provider',
      temperature: 0,
      topP: 1,
      maxOutputTokens: 1,
      reasoningEffort: 'high',
      providerOptions: { responseFormat: ['text', { strict: true }] },
    };

    expect(configPatchSchema.parse(patch)).toEqual(patch);
    expect(Object.keys(configPatchSchema.shape).sort()).toEqual(
      [
        'maxOutputTokens',
        'model',
        'provider',
        'providerCredentialRef',
        'providerOptions',
        'reasoningEffort',
        'temperature',
        'topP',
      ].sort(),
    );
    expect(configPatchSchema.safeParse({}).success).toBe(false);

    for (const forbidden of [
      'trust',
      'sandbox',
      'network',
      'pluginPermissions',
      'revocation',
    ]) {
      expect(configPatchSchema.safeParse({ [forbidden]: true }).success).toBe(
        false,
      );
    }
  });

  test('distinguishes an omitted credential reference from an explicit clear', () => {
    expect(configPatchSchema.parse({ model: 'gpt-5' })).toEqual({
      model: 'gpt-5',
    });
    expect(
      configPatchSchema.parse({
        model: 'gpt-5',
        providerCredentialRef: undefined,
      }),
    ).toEqual({ model: 'gpt-5', providerCredentialRef: undefined });
    expect(
      configPatchSchema.safeParse({ providerCredentialRef: undefined }).success,
    ).toBe(false);
    expect(configPatchSchema.parse({ providerCredentialRef: null })).toEqual({
      providerCredentialRef: null,
    });
    expect(
      configPatchSchema.parse({
        providerCredentialRef: 'credential-store://provider/new',
      }),
    ).toEqual({ providerCredentialRef: 'credential-store://provider/new' });
  });

  test('enforces finite numeric boundaries and positive safe integer tokens', () => {
    for (const valid of [
      { temperature: 0 },
      { temperature: 2 },
      { topP: 0 },
      { topP: 1 },
      { maxOutputTokens: Number.MAX_SAFE_INTEGER },
    ]) {
      expect(configPatchSchema.safeParse(valid).success).toBe(true);
    }

    for (const invalid of [
      { temperature: -Number.EPSILON },
      { temperature: 2.000_001 },
      { temperature: Number.NaN },
      { temperature: Number.POSITIVE_INFINITY },
      { topP: -Number.EPSILON },
      { topP: 1 + Number.EPSILON },
      { topP: Number.NEGATIVE_INFINITY },
      { maxOutputTokens: 0 },
      { maxOutputTokens: 1.5 },
      { maxOutputTokens: Number.MAX_SAFE_INTEGER + 1 },
    ]) {
      expect(configPatchSchema.safeParse(invalid).success).toBe(false);
    }
  });

  test('accepts every JSON value shape and unknown non-secret option keys', () => {
    for (const providerOptions of [
      null,
      true,
      3.5,
      'fast',
      ['text', { vendor_extension: false }],
      { vendorOption: { nested_value: 1 } },
    ]) {
      expect(
        configPatchSchema.parse({ providerOptions }).providerOptions,
      ).toEqual(providerOptions);
    }
  });

  test('rejects normalized secret keys at any depth', () => {
    for (const key of [
      'secret',
      'SECRET',
      'apiKey',
      'api_key',
      'api-key',
      'api.key',
      'api key',
      'api‐key',
      'api＿key',
      'ａｐｉ＿ｋｅｙ',
      'api​key',
      'APİ_KEY',
      'accessToken',
      'access_token',
      'refresh-token',
      'password',
      'privateKey',
      'authorization',
      'cookie',
      'credentialValue',
    ]) {
      const result = configPatchSchema.safeParse({
        providerOptions: {
          outer: [{ nested: { [key]: 'do-not-echo-canary' } }],
        },
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(JSON.stringify(result.error.issues)).not.toContain(
          'do-not-echo-canary',
        );
      }
    }
  });

  test('allows exact non-secret and reference option keys', () => {
    const providerOptions = {
      credentialRef: 'credential-store://provider/main',
      tokenRef: 'credential-store://provider/token',
      tokenizer: 'vendor-tokenizer',
      monkey: true,
      valueFormat: 'json',
      nested: {
        value: 'vendor-value',
        token: 'vendor-token',
        headers: { 'x-vendor-feature': 'enabled' },
        serializedCredential: 'vendor-opaque-metadata',
      },
    };

    expect(
      configPatchSchema.parse({ providerOptions }).providerOptions,
    ).toEqual(providerOptions);
  });

  test('safely rejects hostile non-JSON inputs without invoking getters', () => {
    let getterInvoked = false;
    const withGetter = Object.defineProperty({}, 'secret', {
      enumerable: true,
      get() {
        getterInvoked = true;
        return 'do-not-read';
      },
    });
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    const throwingProxy = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('proxy trap');
        },
      },
    );

    for (const providerOptions of [withGetter, cyclic, throwingProxy]) {
      expect(() =>
        configPatchSchema.safeParse({ providerOptions }),
      ).not.toThrow();
      expect(configPatchSchema.safeParse({ providerOptions }).success).toBe(
        false,
      );
    }
    expect(getterInvoked).toBe(false);
  });

  test('treats prototype-pollution names as inert JSON keys', () => {
    const providerOptions = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(providerOptions, '__proto__', {
      value: { vendorFlag: true },
      enumerable: true,
      writable: true,
      configurable: true,
    });

    const parsed = configPatchSchema.parse({ providerOptions })
      .providerOptions as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(parsed, '__proto__')).toBe(
      true,
    );
    expect(parsed['__proto__']).toEqual({ vendorFlag: true });
    expect(({} as Record<string, unknown>)['vendorFlag']).toBeUndefined();

    Object.defineProperty(providerOptions, '__proto__', {
      value: { secret: 'do-not-echo-canary' },
      enumerable: true,
      writable: true,
      configurable: true,
    });
    expect(configPatchSchema.safeParse({ providerOptions }).success).toBe(
      false,
    );
  });

  test('checks deeply nested option keys without recursive stack growth', () => {
    let providerOptions: Record<string, unknown> = {
      apiKey: 'do-not-echo-canary',
    };
    for (let depth = 0; depth < 10_000; depth += 1) {
      providerOptions = { nested: providerOptions };
    }

    expect(() =>
      configPatchSchema.safeParse({ providerOptions }),
    ).not.toThrow();
    expect(configPatchSchema.safeParse({ providerOptions }).success).toBe(
      false,
    );
  });

  test('exports non-empty patch and recursive secret-key semantics', () => {
    const jsonSchema = toContractJsonSchema(configPatchSchema) as {
      minProperties?: number;
      properties?: {
        providerOptions?: {
          'x-colorful-forbiddenPropertyNames'?: readonly string[];
          'x-colorful-propertyNameNormalization'?: string;
        };
      };
    };

    expect(jsonSchema.minProperties).toBe(1);
    expect(
      jsonSchema.properties?.providerOptions?.[
        'x-colorful-forbiddenPropertyNames'
      ],
    ).toEqual([
      'secret',
      'apikey',
      'accesstoken',
      'refreshtoken',
      'password',
      'privatekey',
      'authorization',
      'cookie',
      'credentialvalue',
    ]);
    expect(
      jsonSchema.properties?.providerOptions?.[
        'x-colorful-propertyNameNormalization'
      ],
    ).toBe('nfkc-lowercase-strip-mark-punctuation-separator-format');
  });

  test('exports canonical credential metadata strings to JSON Schema', () => {
    const jsonSchema = toContractJsonSchema(credentialRefSchema) as {
      properties?: {
        label?: { pattern?: string };
        provider?: { pattern?: string };
      };
    };

    for (const field of ['label', 'provider'] as const) {
      const pattern = new RegExp(jsonSchema.properties?.[field]?.pattern ?? '');
      expect(pattern.test('canonical value')).toBe(true);
      expect(pattern.test(' padded value ')).toBe(false);
    }
  });
});
