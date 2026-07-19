import { describe, expect, test } from 'bun:test';
import { z } from 'zod';

import { toContractJsonSchema } from '@colorful-code/schema';
import { policyChangeBodySchema } from '@colorful-code/schema/commands';
import {
  networkPolicySchema,
  pluginCapabilitiesSchema,
  policyPatchSchema,
} from '@colorful-code/schema/policy';

const asSchemaObject = (value: unknown): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('expected a JSON Schema object');
  }
  return value as Record<string, unknown>;
};

const schemaProperty = (schema: Record<string, unknown>, property: string) =>
  asSchemaObject(asSchemaObject(schema.properties)[property]);

const policyJsonSchema = () =>
  asSchemaObject(toContractJsonSchema(policyPatchSchema));

const allowListedJsonSchema = () => {
  const network = schemaProperty(policyJsonSchema(), 'network');
  const branches = network.oneOf;
  if (!Array.isArray(branches)) throw new TypeError('expected network oneOf');

  const allowListed = branches.map(asSchemaObject).find((branch) => {
    const mode = schemaProperty(branch, 'mode');
    return mode.const === 'allowListed';
  });
  if (allowListed === undefined) {
    throw new TypeError('expected allowListed JSON Schema branch');
  }
  return allowListed;
};

describe('policy patch contract', () => {
  test('accepts exactly the six documented optional fields and requires one', () => {
    const patch = {
      workspaceTrust: 'trusted',
      sandbox: 'workspaceWrite',
      network: {
        mode: 'allowListed',
        allowedHosts: ['api.openai.com', 'example.com'],
      },
      pluginCapabilities: [
        { pluginId: 'plugin-1', capability: 'network.read', decision: 'allow' },
      ],
      credentialRefs: ['credential-store://provider/main'],
      revokeCredentialRefs: ['credential-store://provider/old'],
    };

    expect(policyPatchSchema.parse(patch)).toEqual(patch);
    expect(Object.keys(policyPatchSchema.shape).sort()).toEqual(
      [
        'credentialRefs',
        'network',
        'pluginCapabilities',
        'revokeCredentialRefs',
        'sandbox',
        'workspaceTrust',
      ].sort(),
    );
    expect(policyPatchSchema.safeParse({}).success).toBe(false);
  });

  test('rejects client-side classification and reconciliation fields', () => {
    for (const field of [
      'classification',
      'isTightening',
      'isRelaxation',
      'mixed',
      'effectivePolicy',
      'policyRevision',
    ]) {
      expect(
        policyPatchSchema.safeParse({ sandbox: 'readOnly', [field]: true })
          .success,
      ).toBe(false);
    }
  });

  test('accepts only the documented sandbox values', () => {
    for (const sandbox of ['readOnly', 'workspaceWrite', 'unrestricted']) {
      expect(policyPatchSchema.safeParse({ sandbox }).success).toBe(true);
    }
    expect(policyPatchSchema.safeParse({ sandbox: 'read-write' }).success).toBe(
      false,
    );
  });

  test('enforces strict network variants while allowing an omitted host list', () => {
    for (const network of [
      { mode: 'denyAll' },
      { mode: 'allowListed' },
      { mode: 'allowListed', allowedHosts: [] },
    ]) {
      expect(networkPolicySchema.safeParse(network).success).toBe(true);
    }

    for (const network of [
      { mode: 'denyAll', allowedHosts: [] },
      { mode: 'allowListed', extra: true },
      { mode: 'allowAll' },
    ]) {
      expect(networkPolicySchema.safeParse(network).success).toBe(false);
    }
  });

  test('requires canonical lowercase DNS hostnames without ambiguous authority syntax', () => {
    for (const hostname of [
      'example.com',
      'api.openai.com',
      'a-b.example',
      'localhost',
      'xn--xample-9ua.com',
      `${'a'.repeat(63)}.example`,
    ]) {
      expect(
        networkPolicySchema.safeParse({
          mode: 'allowListed',
          allowedHosts: [hostname],
        }).success,
      ).toBe(true);
    }

    for (const hostname of [
      'Example.com',
      'https://example.com',
      'example.com:443',
      'example.com/path',
      'user@example.com',
      '127.0.0.1',
      '0x7f.0.0.1',
      '0177.0.0.1',
      '2130706433',
      '[::1]',
      '０.example.com',
      'éxample.com',
      '-example.com',
      'example-.com',
      'example..com',
      'example.com.',
      ' example.com',
      `${'a'.repeat(64)}.example`,
      `${'a'.repeat(250)}.com`,
    ]) {
      expect(
        networkPolicySchema.safeParse({
          mode: 'allowListed',
          allowedHosts: [hostname],
        }).success,
      ).toBe(false);
    }
  });

  test('rejects duplicate array entries without imposing unspecified maxima', () => {
    for (const patch of [
      { credentialRefs: ['credential-1', 'credential-1'] },
      { revokeCredentialRefs: ['credential-1', 'credential-1'] },
      {
        network: {
          mode: 'allowListed',
          allowedHosts: ['example.com', 'example.com'],
        },
      },
    ]) {
      expect(policyPatchSchema.safeParse(patch).success).toBe(false);
    }

    const many = Array.from(
      { length: 101 },
      (_, index) => `credential-${index}`,
    );
    const hosts = Array.from(
      { length: 101 },
      (_, index) => `host-${index}.example`,
    );
    expect(policyPatchSchema.safeParse({ credentialRefs: many }).success).toBe(
      true,
    );
    expect(
      policyPatchSchema.safeParse({
        network: { mode: 'allowListed', allowedHosts: hosts },
      }).success,
    ).toBe(true);
  });

  test('rejects padded identities instead of normalizing uniqueness keys', () => {
    for (const patch of [
      { credentialRefs: [' credential-1'] },
      { revokeCredentialRefs: ['credential-1 '] },
      {
        pluginCapabilities: [
          {
            pluginId: ' plugin-1',
            capability: 'filesystem.read',
            decision: 'allow',
          },
        ],
      },
      {
        pluginCapabilities: [
          {
            pluginId: 'plugin-1',
            capability: 'filesystem.read ',
            decision: 'allow',
          },
        ],
      },
    ]) {
      expect(policyPatchSchema.safeParse(patch).success).toBe(false);
    }

    expect(
      policyPatchSchema.safeParse({
        pluginCapabilities: [
          {
            pluginId: 'plugin 1',
            capability: 'filesystem read',
            decision: 'allow',
          },
        ],
        credentialRefs: ['credential ref 1'],
      }).success,
    ).toBe(true);
  });

  test('models each plugin capability decision as one strict declaration', () => {
    const declaration = {
      pluginId: 'plugin-1',
      capability: 'filesystem.read',
      decision: 'deny',
    };

    expect(pluginCapabilitiesSchema.parse(declaration)).toEqual(declaration);
    const longCapability = 'c'.repeat(129);
    expect(
      pluginCapabilitiesSchema.parse({
        ...declaration,
        capability: longCapability,
      }).capability,
    ).toBe(longCapability);
    for (const invalid of [
      { pluginId: 'plugin-1', capabilities: ['filesystem.read'] },
      { ...declaration, decision: 'prompt' },
      { ...declaration, capability: '   ' },
      { ...declaration, extra: true },
    ]) {
      expect(pluginCapabilitiesSchema.safeParse(invalid).success).toBe(false);
    }
  });

  test('rejects duplicate and conflicting declarations by plugin and capability', () => {
    const allow = {
      pluginId: 'plugin-1',
      capability: 'filesystem.read',
      decision: 'allow',
    };
    const deny = { ...allow, decision: 'deny' };

    for (const pluginCapabilities of [
      [allow, allow],
      [allow, deny],
    ]) {
      expect(policyPatchSchema.safeParse({ pluginCapabilities }).success).toBe(
        false,
      );
    }

    expect(
      policyPatchSchema.safeParse({
        pluginCapabilities: [
          allow,
          { ...allow, capability: 'filesystem.write' },
          { ...allow, pluginId: 'plugin-2' },
        ],
      }).success,
    ).toBe(true);
  });
});

describe('policy patch JSON Schema contract', () => {
  test('exports the canonical hostname constraint as one anchored pattern', () => {
    const allowedHosts = schemaProperty(
      allowListedJsonSchema(),
      'allowedHosts',
    );
    const hostname = asSchemaObject(allowedHosts.items);

    expect(typeof hostname.pattern).toBe('string');
    expect((hostname.pattern as string).startsWith('^')).toBe(true);
    expect((hostname.pattern as string).endsWith('$')).toBe(true);
    const pattern = new RegExp(hostname.pattern as string);
    for (const valid of ['example.com', 'localhost', 'xn--xample-9ua.com']) {
      expect(pattern.test(valid)).toBe(true);
    }
    for (const invalid of [
      'Example.com',
      'https://example.com',
      '127.0.0.1',
      '0x7f.0.0.1',
      'éxample.com',
      'example..com',
    ]) {
      expect(pattern.test(invalid)).toBe(false);
    }
  });

  test('exports standard uniqueness for every set-like array', () => {
    const schema = policyJsonSchema();
    const allowedHosts = schemaProperty(
      allowListedJsonSchema(),
      'allowedHosts',
    );

    expect({
      allowedHosts: allowedHosts.uniqueItems,
      credentialRefs: schemaProperty(schema, 'credentialRefs').uniqueItems,
      revokeCredentialRefs: schemaProperty(schema, 'revokeCredentialRefs')
        .uniqueItems,
    }).toEqual({
      allowedHosts: true,
      credentialRefs: true,
      revokeCredentialRefs: true,
    });
  });

  test('exports the non-empty patch object constraint', () => {
    expect(policyJsonSchema().minProperties).toBe(1);
  });

  test('exports stable composite identity metadata for plugin declarations', () => {
    const pluginCapabilities = schemaProperty(
      policyJsonSchema(),
      'pluginCapabilities',
    );

    expect({
      uniqueItems: pluginCapabilities.uniqueItems,
      uniqueBy: pluginCapabilities['x-colorful-uniqueBy'],
    }).toEqual({
      uniqueItems: true,
      uniqueBy: ['pluginId', 'capability'],
    });
  });

  test('exports canonical identity patterns for every uniqueness key', () => {
    const schema = policyJsonSchema();
    const pluginItems = asSchemaObject(
      schemaProperty(schema, 'pluginCapabilities').items,
    );
    const patterns = [
      asSchemaObject(schemaProperty(schema, 'credentialRefs').items).pattern,
      asSchemaObject(schemaProperty(schema, 'revokeCredentialRefs').items)
        .pattern,
      schemaProperty(pluginItems, 'pluginId').pattern,
      schemaProperty(pluginItems, 'capability').pattern,
    ];

    for (const exportedPattern of patterns) {
      expect(typeof exportedPattern).toBe('string');
      const pattern = new RegExp(exportedPattern as string);
      expect(pattern.test('identity')).toBe(true);
      expect(pattern.test('identity with internal spaces')).toBe(true);
      expect(pattern.test(' identity')).toBe(false);
      expect(pattern.test('identity ')).toBe(false);
    }
  });

  test('keeps contract descriptors out of the global metadata registry', () => {
    const allowedHostsSchema =
      networkPolicySchema.options[1].shape.allowedHosts.unwrap();
    const pluginDeclarationsSchema =
      policyPatchSchema.shape.pluginCapabilities.unwrap();
    const credentialRefsSchema =
      policyPatchSchema.shape.credentialRefs.unwrap();
    const revokeCredentialRefsSchema =
      policyPatchSchema.shape.revokeCredentialRefs.unwrap();
    for (const schema of [
      policyPatchSchema,
      allowedHostsSchema,
      pluginDeclarationsSchema,
      credentialRefsSchema,
      revokeCredentialRefsSchema,
    ]) {
      expect(z.globalRegistry.has(schema)).toBe(false);
    }
  });

  test('isolates stable contract output from poisoned global metadata', () => {
    const before = JSON.stringify(toContractJsonSchema(policyPatchSchema));
    const priorMetadata = z.globalRegistry.get(policyPatchSchema);

    try {
      z.globalRegistry.add(policyPatchSchema, {
        minProperties: 99,
        uniqueItems: false,
        'x-colorful-uniqueBy': ['poison'],
      });

      const first = policyJsonSchema();
      const second = policyJsonSchema();
      expect(first.minProperties).toBe(1);
      expect(
        schemaProperty(first, 'pluginCapabilities')['x-colorful-uniqueBy'],
      ).toEqual(['pluginId', 'capability']);
      expect(JSON.stringify(first)).toBe(before);
      expect(JSON.stringify(second)).toBe(before);
    } finally {
      z.globalRegistry.remove(policyPatchSchema);
      if (priorMetadata !== undefined) {
        z.globalRegistry.add(policyPatchSchema, priorMetadata);
      }
    }
  });

  test('applies private metadata when policy is nested under an arbitrary root', () => {
    const rootSchema = z.strictObject({ policy: policyPatchSchema });
    const rootJsonSchema = asSchemaObject(toContractJsonSchema(rootSchema));
    const nestedPolicy = schemaProperty(rootJsonSchema, 'policy');

    expect(nestedPolicy.minProperties).toBe(1);
    expect(schemaProperty(nestedPolicy, 'credentialRefs').uniqueItems).toBe(
      true,
    );
    expect(
      schemaProperty(nestedPolicy, 'pluginCapabilities')['x-colorful-uniqueBy'],
    ).toEqual(['pluginId', 'capability']);
  });
});

describe('policy change command contract', () => {
  test('keeps fencing fields and delegates its patch to the final policy schema', () => {
    const body = {
      commandId: 'command-1',
      expectedPolicyRevision: 3,
      patch: { sandbox: 'readOnly' },
    };

    expect(policyChangeBodySchema.parse(body)).toEqual(body);
    expect(policyChangeBodySchema.shape.patch).toBe(policyPatchSchema);
    expect(
      policyChangeBodySchema.safeParse({
        ...body,
        patch: { sandbox: 'readOnly', classification: 'tightening' },
      }).success,
    ).toBe(false);
  });
});
