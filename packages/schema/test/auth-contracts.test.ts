import { describe, expect, test } from 'bun:test';

import { toContractJsonSchema } from '@colorful-code/schema';
import {
  authenticatedPrincipalSchema,
  daemonEndpointSchema,
  daemonDiscoverySchema,
  tokenRefSchema,
} from '@colorful-code/schema/auth';

const principal = {
  principalId: 'principal-1',
  clientIdentity: 'desktop-client',
  kind: 'installationClient',
  authenticatedAt: '2026-07-18T12:00:00Z',
  credentialVersion: 1,
  capabilities: ['thread.read', 'thread.write'],
};

const discovery = {
  endpoint: 'http://127.0.0.1:43120',
  daemonInstanceId: 'daemon-1',
  tokenRef: 'credential-store://colorful-code/daemon-token',
  protocolVersion: '2',
};

describe('authenticated principal contract', () => {
  test('returns the exact authenticated principal fields', () => {
    expect(authenticatedPrincipalSchema.parse(principal)).toEqual(principal);
    expect(
      authenticatedPrincipalSchema.parse({ ...principal, kind: 'system' }),
    ).toEqual({ ...principal, kind: 'system' });
    expect(Object.keys(authenticatedPrincipalSchema.shape).sort()).toEqual(
      [
        'authenticatedAt',
        'capabilities',
        'clientIdentity',
        'credentialVersion',
        'kind',
        'principalId',
      ].sort(),
    );
  });

  test('rejects invalid identity, kind, timestamp, version, and capabilities', () => {
    for (const invalid of [
      { ...principal, principalId: '   ' },
      { ...principal, clientIdentity: '   ' },
      { ...principal, clientIdentity: ' desktop-client ' },
      { ...principal, kind: 'user' },
      { ...principal, authenticatedAt: '2026-07-18T12:00:00' },
      { ...principal, credentialVersion: -1 },
      { ...principal, credentialVersion: 1.5 },
      { ...principal, capabilities: [''] },
      { ...principal, capabilities: [' thread.read '] },
    ]) {
      expect(authenticatedPrincipalSchema.safeParse(invalid).success).toBe(
        false,
      );
    }
  });

  test('does not impose an unspecified clientIdentity wire maximum', () => {
    const clientIdentity = 'c'.repeat(257);

    expect(
      authenticatedPrincipalSchema.parse({ ...principal, clientIdentity })
        .clientIdentity,
    ).toBe(clientIdentity);
  });

  test('does not impose an unspecified capability wire maximum', () => {
    const capability = 'c'.repeat(129);

    expect(
      authenticatedPrincipalSchema.parse({
        ...principal,
        capabilities: [capability],
      }).capabilities,
    ).toEqual([capability]);
  });

  test('does not impose an unspecified capabilities array maximum', () => {
    const capabilities = Array.from(
      { length: 101 },
      (_, index) => `capability-${index}`,
    );

    expect(
      authenticatedPrincipalSchema.parse({ ...principal, capabilities })
        .capabilities,
    ).toEqual(capabilities);
  });

  test('rejects credential and transport authentication material', () => {
    for (const forbidden of [
      { bearerToken: 'secret' },
      { authorization: 'Bearer secret' },
      { peerUid: 501 },
      { peerSid: 'S-1-5-21' },
      { signingKey: 'secret' },
    ]) {
      expect(
        authenticatedPrincipalSchema.safeParse({
          ...principal,
          ...forbidden,
        }).success,
      ).toBe(false);
    }
  });
});

describe('daemon discovery contract', () => {
  test('accepts only the exact discovery fields and supported local endpoints', () => {
    for (const endpoint of [
      'http://127.0.0.1:43120',
      'unix:/var/run/colorful-code.sock',
      'npipe:////./pipe/colorful-code',
    ]) {
      expect(daemonDiscoverySchema.parse({ ...discovery, endpoint })).toEqual({
        ...discovery,
        endpoint,
      });
    }
    expect(Object.keys(daemonDiscoverySchema.shape).sort()).toEqual(
      ['daemonInstanceId', 'endpoint', 'protocolVersion', 'tokenRef'].sort(),
    );
  });

  test('rejects remote, malformed, token-bearing, and unsupported endpoints', () => {
    for (const endpoint of [
      'http://localhost:43120',
      'http://192.168.1.10:43120',
      'https://127.0.0.1:43120',
      'http://127.0.0.1:43120?token=secret',
      'http://127.0.0.1:0',
      'http://127.0.0.1:65536',
      'unix:',
      'unix:/var/run/colorful-code.sock?token=secret',
      'npipe:',
      'npipe:////./pipe/colorful-code?token=secret',
      'tcp://127.0.0.1:43120',
    ]) {
      expect(
        daemonDiscoverySchema.safeParse({ ...discovery, endpoint }).success,
      ).toBe(false);
    }
  });

  test('rejects non-canonical and authority-ambiguous unix endpoints', () => {
    const endpoints = [
      'unix:relative.sock',
      'unix://remote-host/var/run/colorful-code.sock',
      'unix:///var/run/colorful-code.sock',
    ];

    expect(
      endpoints.map(
        (endpoint) =>
          daemonDiscoverySchema.safeParse({ ...discovery, endpoint }).success,
      ),
    ).toEqual(endpoints.map(() => false));
  });

  test('rejects control characters in unix and named pipe endpoints', () => {
    const endpoints = [
      'unix:/var/run/colorful\u0000code.sock',
      'unix:/var/run/colorful\u0001code.sock',
      'unix:/var/run/colorful\u001fcode.sock',
      'unix:/var/run/colorful\u007fcode.sock',
      'npipe:////./pipe/colorful\u0000code',
      'npipe:////./pipe/colorful\u0001code',
      'npipe:////./pipe/colorful\u001fcode',
      'npipe:////./pipe/colorful\u007fcode',
    ];

    expect(
      endpoints.map(
        (endpoint) =>
          daemonDiscoverySchema.safeParse({ ...discovery, endpoint }).success,
      ),
    ).toEqual(endpoints.map(() => false));
  });

  test('rejects fragments in unix and named pipe endpoints', () => {
    const endpoints = [
      'unix:/var/run/colorful-code.sock#token',
      'npipe:////./pipe/colorful-code#token',
    ];

    expect(
      endpoints.map(
        (endpoint) =>
          daemonDiscoverySchema.safeParse({ ...discovery, endpoint }).success,
      ),
    ).toEqual(endpoints.map(() => false));
  });

  test('rejects a remote named pipe authority', () => {
    expect(
      daemonDiscoverySchema.safeParse({
        ...discovery,
        endpoint: 'npipe:////remote-host/pipe/colorful-code',
      }).success,
    ).toBe(false);
  });

  test('rejects an empty local named pipe name', () => {
    expect(
      daemonDiscoverySchema.safeParse({
        ...discovery,
        endpoint: 'npipe:////./pipe/',
      }).success,
    ).toBe(false);
  });

  test('rejects token values, unknown fields, invalid IDs, and other versions', () => {
    for (const invalid of [
      { ...discovery, token: 'secret' },
      { ...discovery, bearerToken: 'secret' },
      { ...discovery, authorization: 'Bearer secret' },
      { ...discovery, daemonInstanceId: '   ' },
      { ...discovery, tokenRef: '   ' },
      { ...discovery, protocolVersion: '1' },
    ]) {
      expect(daemonDiscoverySchema.safeParse(invalid).success).toBe(false);
    }
  });

  test('documents tokenRef as an OS credential-store reference', () => {
    const jsonSchema = toContractJsonSchema(tokenRefSchema);
    expect(jsonSchema.description?.toLowerCase()).toContain(
      'os credential-store reference',
    );
  });

  test('exports every endpoint restriction to JSON Schema', () => {
    const jsonSchema = toContractJsonSchema(daemonEndpointSchema) as {
      anyOf?: Array<{ pattern?: string }>;
    };
    const patterns =
      jsonSchema.anyOf?.flatMap(({ pattern }) =>
        pattern === undefined ? [] : [new RegExp(pattern)],
      ) ?? [];

    expect(patterns).toHaveLength(3);
    for (const endpoint of [
      'http://127.0.0.1:1',
      'http://127.0.0.1:65535',
      'unix:/tmp/colorful-code.sock',
      'npipe:////./pipe/colorful-code',
    ]) {
      expect(patterns.some((pattern) => pattern.test(endpoint))).toBe(true);
    }
    for (const endpoint of [
      'http://127.0.0.1:0',
      'http://127.0.0.1:65536',
      'unix:/tmp/x\u0000sock',
      'npipe:////./pipe/x\u007fy',
    ]) {
      expect(patterns.some((pattern) => pattern.test(endpoint))).toBe(false);
    }
  });

  test('exports canonical principal string constraints to JSON Schema', () => {
    const jsonSchema = toContractJsonSchema(authenticatedPrincipalSchema) as {
      properties?: {
        capabilities?: { items?: { pattern?: string } };
        clientIdentity?: { pattern?: string };
      };
    };
    const identityPattern = new RegExp(
      jsonSchema.properties?.clientIdentity?.pattern ?? '',
    );
    const capabilityPattern = new RegExp(
      jsonSchema.properties?.capabilities?.items?.pattern ?? '',
    );

    expect(identityPattern.test('desktop-client')).toBe(true);
    expect(identityPattern.test(' desktop-client ')).toBe(false);
    expect(capabilityPattern.test('thread.read')).toBe(true);
    expect(capabilityPattern.test(' thread.read ')).toBe(false);
  });
});
