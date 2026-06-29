import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  loadDevelopmentEnvFileIfPresent,
  loadServerEnvironment,
  toRedactedServerEnvironment,
} from '../src/config/environment';

test('loadServerEnvironment uses development-safe defaults', () => {
  const config = loadServerEnvironment({});
  assert.equal(config.nodeEnv, 'development');
  assert.equal(config.isProduction, false);
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.port, 3001);
  assert.deepEqual(config.corsOrigins, ['http://localhost:3000']);
});

test('loadServerEnvironment accepts a valid PORT', () => {
  const config = loadServerEnvironment({ PORT: '49152' });
  assert.equal(config.port, 49152);
});

test('loadServerEnvironment rejects an invalid PORT', () => {
  assert.throws(
    () => loadServerEnvironment({ PORT: 'abc' }),
    /PORT must be an integer between 1 and 65535/,
  );
});

test('loadServerEnvironment parses comma-separated CORS origins', () => {
  const config = loadServerEnvironment({
    CORS_ORIGIN: 'https://app.example.com, https://admin.example.com',
  });
  assert.deepEqual(config.corsOrigins, [
    'https://app.example.com',
    'https://admin.example.com',
  ]);
});

test('loadServerEnvironment requires CORS_ORIGIN in production', () => {
  assert.throws(
    () => loadServerEnvironment({ NODE_ENV: 'production' }),
    /CORS_ORIGIN is required when NODE_ENV=production/,
  );
});

test('loadServerEnvironment rejects malformed CORS origins', () => {
  assert.throws(
    () =>
      loadServerEnvironment({
        NODE_ENV: 'production',
        CORS_ORIGIN: 'https://app.example.com,not-a-url',
      }),
    /CORS_ORIGIN entries must be absolute http\(s\) origins/,
  );
});

test('toRedactedServerEnvironment masks provider secrets', () => {
  const redacted = toRedactedServerEnvironment(
    loadServerEnvironment({
      ANTHROPIC_API_KEY: 'sk-ant-real',
      OPENAI_API_KEY: '',
      DEEPSEEK_API_KEY: 'deepseek-real',
    }),
  );

  assert.equal(redacted.providerKeys.anthropic, '[set]');
  assert.equal(redacted.providerKeys.openai, '[unset]');
  assert.equal(redacted.providerKeys.deepseek, '[set]');
  assert.equal(JSON.stringify(redacted).includes('sk-ant-real'), false);
  assert.equal(JSON.stringify(redacted).includes('deepseek-real'), false);
});

test('loadDevelopmentEnvFileIfPresent loads .env outside production', () => {
  const dir = mkdtempSync(join(tmpdir(), 'colorful-code-env-'));
  const previousPort = process.env.PORT;
  try {
    writeFileSync(join(dir, '.env'), 'PORT=3901\n');
    delete process.env.PORT;
    loadDevelopmentEnvFileIfPresent(dir, { NODE_ENV: 'development' });
    assert.equal(process.env.PORT, '3901');
  } finally {
    if (previousPort === undefined) {
      delete process.env.PORT;
    } else {
      process.env.PORT = previousPort;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadDevelopmentEnvFileIfPresent skips .env in production', () => {
  const dir = mkdtempSync(join(tmpdir(), 'colorful-code-env-'));
  const previousPort = process.env.PORT;
  try {
    writeFileSync(join(dir, '.env'), 'PORT=3901\n');
    delete process.env.PORT;
    loadDevelopmentEnvFileIfPresent(dir, { NODE_ENV: 'production' });
    assert.equal(process.env.PORT, undefined);
  } finally {
    if (previousPort === undefined) {
      delete process.env.PORT;
    } else {
      process.env.PORT = previousPort;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
