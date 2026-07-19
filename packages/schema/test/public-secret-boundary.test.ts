import { describe, expect, test } from 'bun:test';
import { z } from 'zod';

import * as publicContracts from '@colorful-code/schema';

const forbiddenNames = new Set([
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

const ignoredNameCharacters =
  /[\p{Mark}\p{Punctuation}\p{Separator}\p{Format}]/gu;

const normalizeName = (value: string) =>
  value.normalize('NFKC').toLowerCase().replace(ignoredNameCharacters, '');

const compareText = (left: string, right: string) =>
  left < right ? -1 : left > right ? 1 : 0;

type JsonSchemaFrame = {
  mode: 'data' | 'propertyMap' | 'schema';
  path: string;
  value: unknown;
};

const sensitiveJsonSchemaPaths = (jsonSchema: unknown): string[] => {
  const failures = new Set<string>();
  const pending: JsonSchemaFrame[] = [
    { mode: 'schema', path: '$', value: jsonSchema },
  ];
  const visited = {
    data: new WeakSet<object>(),
    propertyMap: new WeakSet<object>(),
    schema: new WeakSet<object>(),
  };

  while (pending.length > 0) {
    const frame = pending.pop();
    if (frame === undefined) break;

    if (typeof frame.value === 'string') {
      const normalizedText = normalizeName(frame.value);
      if (
        frame.mode === 'data' &&
        [...forbiddenNames].some((name) => normalizedText.includes(name))
      ) {
        failures.add(frame.path);
      }
      continue;
    }
    if (frame.value === null || typeof frame.value !== 'object') continue;
    if (visited[frame.mode].has(frame.value)) continue;
    visited[frame.mode].add(frame.value);

    if (Array.isArray(frame.value)) {
      for (let index = frame.value.length - 1; index >= 0; index -= 1) {
        pending.push({
          mode: frame.mode,
          path: `${frame.path}[${index}]`,
          value: frame.value[index],
        });
      }
      continue;
    }

    const entries = Object.entries(frame.value).sort(([left], [right]) =>
      compareText(right, left),
    );
    for (const [key, value] of entries) {
      const path = `${frame.path}.${key}`;
      if (
        (frame.mode === 'data' || frame.mode === 'propertyMap') &&
        forbiddenNames.has(normalizeName(key))
      ) {
        failures.add(path);
      }
      const isMetadataContent =
        frame.mode === 'schema' &&
        (key === 'description' ||
          key === 'example' ||
          key === 'examples' ||
          key === 'default');
      pending.push({
        mode:
          frame.mode === 'propertyMap'
            ? 'schema'
            : isMetadataContent
              ? 'data'
              : frame.mode === 'schema' && key === 'properties'
                ? 'propertyMap'
                : frame.mode,
        path,
        value,
      });
    }
  }

  return [...failures].sort(compareText);
};

type SchemaExport = readonly [name: string, schema: z.ZodType];
type JsonSchemaConverter = (schema: z.ZodType) => unknown;

const publicZodSchemas = (exports: Record<string, unknown>): SchemaExport[] =>
  Object.entries(exports)
    .filter(
      (entry): entry is [string, z.ZodType] => entry[1] instanceof z.ZodType,
    )
    .sort(([left], [right]) => compareText(left, right));

const inspectSchemaExports = (
  exports: Record<string, unknown>,
  converter: JsonSchemaConverter = publicContracts.toContractJsonSchema,
): string[] => {
  const failures: string[] = [];

  for (const [name, schema] of publicZodSchemas(exports)) {
    let jsonSchema: unknown;
    try {
      jsonSchema = converter(schema);
    } catch {
      failures.push(`${name} at $ (JSON Schema generation failed)`);
      continue;
    }
    for (const path of sensitiveJsonSchemaPaths(jsonSchema)) {
      failures.push(`${name} at ${path}`);
    }
  }

  return failures;
};

describe('public Secret Gate', () => {
  test('generates and scans every Zod schema exported by the package barrel', () => {
    const schemas = publicZodSchemas(publicContracts);

    expect(schemas.map(([name]) => name)).toContain('credentialRefIdSchema');
    expect(schemas.map(([name]) => name)).toContain('daemonDiscoverySchema');
    expect(schemas.map(([name]) => name)).toContain('policyPatchSchema');
    expect(inspectSchemaExports(publicContracts)).toEqual([]);
  });

  test('uses isolated contract metadata despite a poisoned global registry', () => {
    const priorMetadata = z.globalRegistry.get(
      publicContracts.policyPatchSchema,
    );

    try {
      z.globalRegistry.add(publicContracts.policyPatchSchema, {
        description: 'Uses an API key for authorization',
        minProperties: 99,
      });

      const first = inspectSchemaExports(publicContracts);
      const second = inspectSchemaExports(publicContracts);
      expect(first).toEqual([]);
      expect(second).toEqual(first);

      const contractSchema = publicContracts.toContractJsonSchema(
        publicContracts.policyPatchSchema,
      ) as Record<string, unknown>;
      const properties = contractSchema.properties as Record<
        string,
        Record<string, unknown>
      >;
      expect(contractSchema.minProperties).toBe(1);
      expect(properties.credentialRefs.uniqueItems).toBe(true);
      expect(properties.revokeCredentialRefs.uniqueItems).toBe(true);
    } finally {
      z.globalRegistry.remove(publicContracts.policyPatchSchema);
      if (priorMetadata !== undefined) {
        z.globalRegistry.add(publicContracts.policyPatchSchema, priorMetadata);
      }
    }
  });

  test('preserves all formal descriptions despite poisoned global metadata', () => {
    const describedSchemas = [
      publicContracts.tokenRefSchema,
      publicContracts.streamBasisSchema,
      publicContracts.durableBasisSchema,
    ] as const;
    const priorMetadata = describedSchemas.map((schema) =>
      z.globalRegistry.get(schema),
    );

    try {
      for (const schema of describedSchemas) {
        z.globalRegistry.add(schema, {
          description: 'poisoned global description',
        });
      }

      const tokenRef = publicContracts.toContractJsonSchema(
        publicContracts.tokenRefSchema,
      );
      const streamBasis = publicContracts.toContractJsonSchema(
        publicContracts.streamBasisSchema,
      );
      const durableBasis = publicContracts.toContractJsonSchema(
        publicContracts.durableBasisSchema,
      );
      expect(tokenRef.description?.toLowerCase()).toContain(
        'os credential-store reference',
      );
      expect(streamBasis.description).toContain(
        'specific incarnation stream space',
      );
      expect(durableBasis.description).toContain('durable cursor space');

      const first = JSON.stringify(
        publicContracts.toContractJsonSchema(
          publicContracts.threadStreamFrameSchema,
        ),
      );
      const second = JSON.stringify(
        publicContracts.toContractJsonSchema(
          publicContracts.threadStreamFrameSchema,
        ),
      );
      expect(second).toBe(first);
    } finally {
      describedSchemas.forEach((schema, index) => {
        z.globalRegistry.remove(schema);
        const prior = priorMetadata[index];
        if (prior !== undefined) z.globalRegistry.add(schema, prior);
      });
    }
  });

  test('allows exact public reference fields', () => {
    expect(
      publicContracts.credentialRefSchema.safeParse({
        credentialRef: 'credential-store://provider/main',
        provider: 'provider',
        label: 'main',
        createdAt: '2026-07-19T10:30:00+08:00',
      }).success,
    ).toBe(true);
    expect(
      publicContracts.daemonDiscoverySchema.safeParse({
        daemonInstanceId: 'daemon-1',
        endpoint: 'http://127.0.0.1:43120',
        protocolVersion: '2',
        tokenRef: 'credential-store://provider/daemon',
      }).success,
    ).toBe(true);
    expect(
      publicContracts.policyPatchSchema.safeParse({
        credentialRefs: ['credential-store://provider/main'],
        revokeCredentialRefs: ['credential-store://provider/old'],
      }).success,
    ).toBe(true);
  });

  test('rejects secret-bearing provider options at arbitrary depth', () => {
    let providerOptions: Record<string, unknown> = {
      access_token: 'do-not-echo-canary',
    };
    for (let depth = 0; depth < 200; depth += 1) {
      providerOptions = { nested: [providerOptions] };
    }

    expect(
      publicContracts.configPatchSchema.safeParse({ providerOptions }).success,
    ).toBe(false);
  });

  test('finds forbidden fields and metadata without echoing their values', () => {
    const eventPayload = z.strictObject({
      payload: z.strictObject({ api_key: z.string() }),
    });
    const commandBody = z.strictObject({
      body: z.strictObject({
        'access-token': z.string(),
        privateKey: z.string(),
      }),
    });
    const documented = z.string();
    const documentedMetadata = {
      authorization: 'ordinary custom metadata keyword',
      description: 'Uses an API key for authorization',
      examples: [
        { nested: { cookie: 'do-not-echo-canary' } },
        'Refresh token documentation',
      ],
      default: {
        settings: { credentialValue: 'do-not-echo-canary' },
      },
      'x-provider-docs': { secret: 'do-not-echo-canary' },
    };
    const defaultText = z.string();
    const defaultTextMetadata = {
      default: 'Private key fallback',
    };
    const fixtures = { commandBody, defaultText, documented, eventPayload };
    const fixtureConverter: JsonSchemaConverter = (schema) => {
      const metadata = z.registry<Record<string, unknown>>();
      metadata.add(documented, documentedMetadata);
      metadata.add(defaultText, defaultTextMetadata);
      return z.toJSONSchema(schema, { metadata });
    };

    const failures = inspectSchemaExports(fixtures, fixtureConverter);
    const reversedFixtures = Object.fromEntries(
      Object.entries(fixtures).reverse(),
    );
    expect(failures).toEqual([
      'commandBody at $.properties.body.properties.access-token',
      'commandBody at $.properties.body.properties.privateKey',
      'defaultText at $.default',
      'documented at $.default.settings.credentialValue',
      'documented at $.description',
      'documented at $.examples[0].nested.cookie',
      'documented at $.examples[1]',
      'eventPayload at $.properties.payload.properties.api_key',
    ]);
    expect(inspectSchemaExports(fixtures, fixtureConverter)).toEqual(failures);
    expect(inspectSchemaExports(reversedFixtures, fixtureConverter)).toEqual(
      failures,
    );
    expect(failures.join('\n')).not.toContain('do-not-echo-canary');
  });

  test('reports JSON Schema generation failures by export name only', () => {
    const failures = inspectSchemaExports({ impossibleSchema: z.undefined() });

    expect(failures).toEqual([
      'impossibleSchema at $ (JSON Schema generation failed)',
    ]);
  });

  test('represents the no-JSON-body contract as an unsatisfiable schema', () => {
    expect(
      publicContracts.undefinedResultSchema.safeParse(undefined).success,
    ).toBe(true);
    expect(
      publicContracts.toContractJsonSchema(
        publicContracts.undefinedResultSchema,
      ),
    ).toEqual({ not: {} });
    expect(
      publicContracts.httpContractRegistry['event.attach'].resultSchema,
    ).toBe(publicContracts.undefinedResultSchema);
  });
});
