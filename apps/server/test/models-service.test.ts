import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { ModelClientConfig } from '../src/model/model-config';
import {
  listOpenAICompatibleModels,
  publicModelPresets,
  probeModelConnection,
} from '../src/model/models-service';

test('publicModelPresets returns adapter metadata without secrets', () => {
  const presets = publicModelPresets();

  assert.deepEqual(
    presets.map((preset) => preset.id),
    ['claude', 'deepseek', 'openai', 'custom'],
  );
  assert.equal('apiKey' in presets[0]!, false);
  assert.equal(
    presets.find((preset) => preset.id === 'custom')?.requiresModel,
    true,
  );
});

test('listOpenAICompatibleModels reads ids from a compatible /models endpoint', async () => {
  const calls: Array<{ url: string; authorization: string | null }> = [];
  const fetcher: typeof fetch = async (url, init) => {
    const headers = new Headers(init?.headers);
    calls.push({
      url: String(url),
      authorization: headers.get('authorization'),
    });
    return new Response(
      JSON.stringify({
        data: [{ id: 'gpt-4o' }, { id: 'gpt-4o-mini' }, { noId: true }],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };

  const models = await listOpenAICompatibleModels(
    {
      protocol: 'openai',
      baseURL: 'https://example.test/v1/',
      apiKey: 'sk-test',
      model: 'gpt-4o',
    },
    fetcher,
  );

  assert.deepEqual(models, ['gpt-4o', 'gpt-4o-mini']);
  assert.deepEqual(calls, [
    {
      url: 'https://example.test/v1/models',
      authorization: 'Bearer sk-test',
    },
  ]);
});

test('listOpenAICompatibleModels rejects non-openai adapters', async () => {
  await assert.rejects(
    () =>
      listOpenAICompatibleModels({
        protocol: 'anthropic',
        apiKey: 'sk-ant',
        model: 'claude',
      }),
    /only available for OpenAI-compatible adapters/,
  );
});

test('probeModelConnection reports the first text from the adapter stream', async () => {
  const seen: ModelClientConfig[] = [];
  const result = await probeModelConnection(
    {
      protocol: 'openai',
      apiKey: 'sk-test',
      model: 'gpt-4o',
    },
    (config) => {
      seen.push(config);
      return {
        async *run() {
          yield { type: 'text' as const, text: 'OK' };
          yield { type: 'end' as const };
        },
      };
    },
  );

  assert.equal(result.sample, 'OK');
  assert.equal(seen[0]?.apiKey, 'sk-test');
});
