import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createV2Boundary } from '../src/v2/v2-boundary';
import { loadServerEnvironment } from '../src/config/environment';

test('2.0 boundary is disabled by default and owns no persistence', () => {
  assert.equal(loadServerEnvironment({ NODE_ENV: 'test' }).v2Enabled, false);
  assert.equal(
    loadServerEnvironment({
      NODE_ENV: 'test',
      COLORFUL_CODE_V2_ENABLED: 'true',
    }).v2Enabled,
    true,
  );
  assert.deepEqual(createV2Boundary(true), {
    enabled: true,
    persistenceOwner: 'none',
  });
  const source = readFileSync(
    new URL('../src/v2/v2-boundary.ts', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(source, /SessionStore|persistence\/session-store/);
});

test('2.0 flag rejects ambiguous values', () => {
  assert.throws(
    () =>
      loadServerEnvironment({
        NODE_ENV: 'test',
        COLORFUL_CODE_V2_ENABLED: 'yes',
      }),
    /COLORFUL_CODE_V2_ENABLED must be true or false/,
  );
});
