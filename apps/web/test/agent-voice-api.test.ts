import { strict as assert } from 'node:assert';
import { afterEach, test } from 'node:test';
import {
  appendVoiceAudio,
  startVoiceTranscription,
  stopVoiceTranscription,
} from '../app/agent/api';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('voice transcription API posts start, audio, and stop requests to session endpoints', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return Promise.resolve(new Response('{}', { status: 202 }));
  }) as typeof fetch;

  await startVoiceTranscription('session 1', {
    requestId: 'voice-1',
    apiKey: 'sk-user',
    model: 'gpt-4o-mini-transcribe',
    language: 'zh',
  });
  await appendVoiceAudio('session 1', {
    audio: 'AAAA',
    sampleRate: 24_000,
    numChannels: 1,
  });
  await stopVoiceTranscription('session 1');

  assert.deepEqual(
    calls.map((call) => ({
      url: call.url,
      method: call.init?.method,
      body: JSON.parse(String(call.init?.body ?? '{}')),
    })),
    [
      {
        url: 'http://127.0.0.1:3001/sessions/session%201/voice/start',
        method: 'POST',
        body: {
          requestId: 'voice-1',
          apiKey: 'sk-user',
          model: 'gpt-4o-mini-transcribe',
          language: 'zh',
        },
      },
      {
        url: 'http://127.0.0.1:3001/sessions/session%201/voice/audio',
        method: 'POST',
        body: {
          audio: 'AAAA',
          sampleRate: 24_000,
          numChannels: 1,
        },
      },
      {
        url: 'http://127.0.0.1:3001/sessions/session%201/voice/stop',
        method: 'POST',
        body: {},
      },
    ],
  );
});
