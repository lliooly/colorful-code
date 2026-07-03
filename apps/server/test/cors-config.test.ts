import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { buildCorsOptions } from '../src/config/cors';

test('server CORS allows plugin management mutation methods', () => {
  const options = buildCorsOptions(['http://localhost:3000']);

  assert.deepEqual(options.origin, ['http://localhost:3000']);
  assert.ok(Array.isArray(options.methods));
  assert.ok(options.methods.includes('PATCH'));
  assert.ok(options.methods.includes('DELETE'));
  assert.ok(options.methods.includes('OPTIONS'));
});
