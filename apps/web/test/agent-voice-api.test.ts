import { strict as assert } from 'node:assert';
import { afterEach, test } from 'node:test';
import {
  appendVoiceAudio,
  clearSessions,
  createSession,
  deleteProject,
  deleteSession,
  importProject,
  pinSession,
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
        url: 'http://127.0.0.1:3367/sessions/session%201/voice/start',
        method: 'POST',
        body: {
          requestId: 'voice-1',
          apiKey: 'sk-user',
          model: 'gpt-4o-mini-transcribe',
          language: 'zh',
        },
      },
      {
        url: 'http://127.0.0.1:3367/sessions/session%201/voice/audio',
        method: 'POST',
        body: {
          audio: 'AAAA',
          sampleRate: 24_000,
          numChannels: 1,
        },
      },
      {
        url: 'http://127.0.0.1:3367/sessions/session%201/voice/stop',
        method: 'POST',
        body: {},
      },
    ],
  );
});

test('project and history API helpers call the grouped history endpoints', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith('/sessions')) {
      return Promise.resolve(
        new Response(
          JSON.stringify({ id: 'session-project', needsModelConfig: false }),
          {
            status: 201,
          },
        ),
      );
    }
    if (String(url).endsWith('/projects')) {
      return Promise.resolve(
        new Response(JSON.stringify({ id: 'project-1' }), { status: 201 }),
      );
    }
    return Promise.resolve(new Response('{}', { status: 204 }));
  }) as typeof fetch;

  assert.deepEqual(
    await createSession({ projectId: 'project-1', permissionMode: 'default' }),
    { id: 'session-project', needsModelConfig: false },
  );
  await importProject('/Users/example/workspace');
  await deleteProject('project-1');
  await pinSession('session-project', true);
  await deleteSession('session-project');
  await clearSessions({ scope: 'standalone' });
  await clearSessions({ projectId: 'project-1' });

  assert.deepEqual(
    calls.map((call) => ({
      url: call.url,
      method: call.init?.method ?? 'GET',
      body: call.init?.body ? JSON.parse(String(call.init.body)) : undefined,
    })),
    [
      {
        url: 'http://127.0.0.1:3367/sessions',
        method: 'POST',
        body: { projectId: 'project-1', permissionMode: 'default' },
      },
      {
        url: 'http://127.0.0.1:3367/projects',
        method: 'POST',
        body: { path: '/Users/example/workspace' },
      },
      {
        url: 'http://127.0.0.1:3367/projects/project-1',
        method: 'DELETE',
        body: undefined,
      },
      {
        url: 'http://127.0.0.1:3367/sessions/session-project',
        method: 'PATCH',
        body: { pinned: true },
      },
      {
        url: 'http://127.0.0.1:3367/sessions/session-project',
        method: 'DELETE',
        body: undefined,
      },
      {
        url: 'http://127.0.0.1:3367/sessions?scope=standalone',
        method: 'DELETE',
        body: undefined,
      },
      {
        url: 'http://127.0.0.1:3367/sessions?projectId=project-1',
        method: 'DELETE',
        body: undefined,
      },
    ],
  );
});
