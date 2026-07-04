import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import cors from '@fastify/cors';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { buildCorsOptions } from '../src/config/cors';

test('server CORS allows plugin management mutation methods', () => {
  const options = buildCorsOptions(['http://localhost:3000']);

  assert.deepEqual(options.origin, ['http://localhost:3000']);
  assert.ok(Array.isArray(options.methods));
  assert.ok(options.methods.includes('PATCH'));
  assert.ok(options.methods.includes('DELETE'));
  assert.ok(options.methods.includes('OPTIONS'));
});

test('server CORS allows Tauri desktop origins', async () => {
  const app = new FastifyAdapter().getInstance();

  try {
    await app.register(
      cors,
      buildCorsOptions([
        'http://localhost:3000',
        'http://127.0.0.1:3000',
        'http://tauri.localhost',
        'https://tauri.localhost',
        'tauri://localhost',
        'null',
      ]),
    );
    app.get('/health', async () => ({ status: 'ok' }));
    await app.ready();

    for (const origin of [
      'http://tauri.localhost',
      'https://tauri.localhost',
      'tauri://localhost',
      'null',
    ]) {
      const response = await app.inject({
        method: 'GET',
        url: '/health',
        headers: {
          origin,
        },
      });

      assert.equal(response.statusCode, 200);
      assert.equal(response.headers['access-control-allow-origin'], origin);
    }
  } finally {
    await app.close();
  }
});
