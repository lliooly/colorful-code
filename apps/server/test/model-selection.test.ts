import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { ServerEnvironment } from '../src/config/environment';
import {
  buildModelClientConfig,
  resolveModelPreset,
} from '../src/model/model-config';
import {
  ModelSelectionError,
  resolveModelClientConfig,
} from '../src/sessions/model-factory';

// ---------------------------------------------------------------------------
// Selection resolution: preset -> protocol/model/baseURL, key resolution by
// protocol/preset, the custom BYO path, and the clear failures (no key,
// incomplete custom). No network, no real keys.
// ---------------------------------------------------------------------------

function env(
  keys: Partial<ServerEnvironment['providerKeys']> = {},
): ServerEnvironment {
  return {
    nodeEnv: 'test',
    isProduction: false,
    host: '127.0.0.1',
    port: 3001,
    corsOrigins: ['http://localhost:3000'],
    databasePath: ':memory:',
    providerKeys: {
      anthropic: keys.anthropic,
      openai: keys.openai,
      deepseek: keys.deepseek,
    },
  };
}

test('resolveModelPreset defaults to claude and rejects unknown ids', () => {
  assert.equal(resolveModelPreset().id, 'claude');
  assert.equal(resolveModelPreset('deepseek').id, 'deepseek');
  assert.throws(() => resolveModelPreset('nope'), /Unknown model preset: nope/);
});

test('buildModelClientConfig merges preset defaults with overrides', () => {
  const config = buildModelClientConfig({
    presetId: 'deepseek',
    apiKey: 'k',
  });
  assert.equal(config.protocol, 'openai');
  assert.equal(config.baseURL, 'https://api.deepseek.com');
  assert.equal(config.model, 'deepseek-v4-pro');

  const overridden = buildModelClientConfig({
    presetId: 'openai',
    overrides: { model: 'gpt-5', maxTokens: 99 },
    apiKey: 'k',
  });
  assert.equal(overridden.model, 'gpt-5');
  assert.equal(overridden.maxTokens, 99);
  assert.equal(overridden.baseURL, undefined);
});

test('claude selection pulls the anthropic key by default', () => {
  const config = resolveModelClientConfig(env({ anthropic: 'sk-ant' }));
  assert.equal(config.protocol, 'anthropic');
  assert.equal(config.model, 'claude-fable-5');
  assert.equal(config.apiKey, 'sk-ant');
});

test('deepseek selection pulls the deepseek key (not openai)', () => {
  const config = resolveModelClientConfig(
    env({ deepseek: 'ds-key', openai: 'oai-key' }),
    { preset: 'deepseek' },
  );
  assert.equal(config.apiKey, 'ds-key');
  assert.equal(config.baseURL, 'https://api.deepseek.com');
});

test('named presets may use a request-scoped api key before falling back to env keys', () => {
  const config = resolveModelClientConfig(env(), {
    preset: 'openai',
    apiKey: 'request-key',
  });

  assert.equal(config.protocol, 'openai');
  assert.equal(config.model, 'gpt-5.5');
  assert.equal(config.apiKey, 'request-key');
});

test('custom selection uses the request BYO key + supplied protocol/model', () => {
  const config = resolveModelClientConfig(env(), {
    preset: 'custom',
    protocol: 'openai',
    baseURL: 'http://localhost:11434/v1',
    model: 'local-model',
    apiKey: 'byo-key',
  });
  assert.equal(config.protocol, 'openai');
  assert.equal(config.baseURL, 'http://localhost:11434/v1');
  assert.equal(config.model, 'local-model');
  assert.equal(config.apiKey, 'byo-key');
});

test('missing provider key fails with ModelSelectionError', () => {
  assert.throws(
    () => resolveModelClientConfig(env(), { preset: 'claude' }),
    (error: unknown) =>
      error instanceof ModelSelectionError &&
      /No API key configured for the "claude"/.test(error.message),
  );
});

test('custom without an apiKey fails with ModelSelectionError', () => {
  assert.throws(
    () =>
      resolveModelClientConfig(env(), {
        preset: 'custom',
        protocol: 'openai',
        model: 'x',
      }),
    (error: unknown) =>
      error instanceof ModelSelectionError &&
      /requires an `apiKey`/.test(error.message),
  );
});

test('custom without protocol/model fails with ModelSelectionError', () => {
  assert.throws(
    () =>
      resolveModelClientConfig(env(), {
        preset: 'custom',
        apiKey: 'byo',
      }),
    (error: unknown) =>
      error instanceof ModelSelectionError &&
      /has no protocol/.test(error.message),
  );
});
