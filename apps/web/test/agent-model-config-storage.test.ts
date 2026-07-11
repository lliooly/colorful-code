import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  loadPersistedModelPreferences,
  serializeModelPreferences,
} from '../app/agent/model-config-storage';

test('legacy model config drops persisted API keys', () => {
  const loaded = loadPersistedModelPreferences(JSON.stringify({
    presetId: 'openai',
    presetApiKeys: { openai: 'server-secret' },
    customApiKey: 'custom-secret',
    customProtocol: 'openai',
    customBaseURL: 'http://localhost:11434/v1',
    customModel: 'local',
  }));
  assert.equal(loaded.presetId, 'openai');
  assert.equal(loaded.customBaseURL, 'http://localhost:11434/v1');
  assert.doesNotMatch(JSON.stringify(loaded), /server-secret|custom-secret/);
});

test('serialized model preferences contain only non-sensitive fields', () => {
  const serialized = serializeModelPreferences({
    presetId: 'claude',
    presetModelOverrides: { claude: 'model' },
    customProtocol: 'anthropic',
    customBaseURL: '',
    customModel: '',
  });
  assert.deepEqual(JSON.parse(serialized), {
    presetId: 'claude',
    presetModelOverrides: { claude: 'model' },
    customProtocol: 'anthropic',
    customBaseURL: '',
    customModel: '',
  });
});
