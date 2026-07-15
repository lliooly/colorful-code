import { describe, expect, test } from 'bun:test';

import { healthResponseSchema } from '@colorful-code/schema';

const domainEntrypoints = [
  'ack',
  'auth',
  'commands',
  'common',
  'config',
  'enums',
  'errors',
  'events',
  'ids',
  'operations',
  'policy',
  'queue',
  'run',
  'snapshot',
  'thread'
] as const;

describe('domain entrypoints', () => {
  test.each(domainEntrypoints)('loads @colorful-code/schema/%s', async (entrypoint) => {
    await expect(import(`@colorful-code/schema/${entrypoint}`)).resolves.toBeDefined();
  });
});

describe('healthResponseSchema', () => {
  test('accepts an ok status', () => {
    expect(healthResponseSchema.safeParse({ status: 'ok' }).success).toBe(true);
  });

  test('rejects any other status', () => {
    expect(healthResponseSchema.safeParse({ status: 'error' }).success).toBe(false);
  });
});
