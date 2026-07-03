import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { ServerEnvironment } from '../src/config/environment';
import {
  parseRealtimeTranscriptionEvent,
  validateVoiceAudioChunk,
  VoiceTranscriptionService,
  type RealtimeSocketEvent,
} from '../src/sessions/voice-transcription';

function env(openai = 'sk-test'): ServerEnvironment {
  return {
    nodeEnv: 'test',
    isProduction: false,
    host: '127.0.0.1',
    port: 3001,
    corsOrigins: ['http://localhost:3000'],
    databasePath: ':memory:',
    providerKeys: {
      anthropic: undefined,
      deepseek: undefined,
      openai,
    },
  };
}

class FakeSocket {
  readonly sent: string[] = [];
  readonly listeners = new Map<
    string,
    Array<(event: RealtimeSocketEvent) => void>
  >();

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.dispatch('close', {});
  }

  addEventListener(
    type: 'open' | 'message' | 'error' | 'close',
    listener: (event: RealtimeSocketEvent) => void,
  ): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  dispatch(type: string, event: RealtimeSocketEvent): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

test('parseRealtimeTranscriptionEvent maps OpenAI transcript delta events', () => {
  assert.deepEqual(
    parseRealtimeTranscriptionEvent({
      type: 'conversation.item.input_audio_transcription.delta',
      delta: 'hello',
    }),
    { type: 'voice_transcript_delta', text: 'hello' },
  );

  assert.deepEqual(
    parseRealtimeTranscriptionEvent({
      type: 'conversation.item.input_audio_transcription.completed',
      transcript: 'hello world',
    }),
    { type: 'voice_transcript_done', text: 'hello world' },
  );
});

test('parseRealtimeTranscriptionEvent maps realtime errors defensively', () => {
  assert.deepEqual(
    parseRealtimeTranscriptionEvent({
      type: 'error',
      error: { message: 'bad audio' },
    }),
    { type: 'voice_transcript_error', message: 'bad audio' },
  );

  assert.equal(
    parseRealtimeTranscriptionEvent({ type: 'rate_limits.updated' }),
    null,
  );
});

test('validateVoiceAudioChunk accepts base64 PCM metadata and rejects malformed audio', () => {
  assert.deepEqual(
    validateVoiceAudioChunk({
      audio: Buffer.from([0, 1, 2, 3]).toString('base64'),
      sampleRate: 24_000,
      numChannels: 1,
    }),
    {
      audio: Buffer.from([0, 1, 2, 3]).toString('base64'),
      sampleRate: 24_000,
      numChannels: 1,
    },
  );

  assert.throws(
    () =>
      validateVoiceAudioChunk({
        audio: '',
        sampleRate: 44_100,
        numChannels: 2,
      }),
    /audio/,
  );
});

test('VoiceTranscriptionService forwards queued audio to realtime websocket after open', () => {
  const socket = new FakeSocket();
  const service = new VoiceTranscriptionService(env());
  service.setSocketFactoryForTesting((url, options) => {
    assert.match(url, /wss:\/\/api\.openai\.com\/v1\/realtime/);
    assert.equal(options.headers.Authorization, 'Bearer sk-test');
    assert.equal(options.headers['OpenAI-Beta'], 'realtime=v1');
    return socket;
  });

  const events: unknown[] = [];
  service.start('session-a', 'voice-1', { language: 'zh' }, (event) => {
    events.push(event);
  });
  service.appendAudio('session-a', {
    audio: 'AAAA',
    sampleRate: 24_000,
    numChannels: 1,
  });
  assert.equal(socket.sent.length, 0, 'audio waits until socket opens');

  socket.dispatch('open', {});

  assert.deepEqual(
    socket.sent.map((message) => JSON.parse(message) as { type: string }),
    [
      {
        type: 'session.update',
        session: {
          input_audio_format: 'pcm16',
          input_audio_transcription: {
            model: 'gpt-4o-mini-transcribe',
            language: 'zh',
          },
          turn_detection: { type: 'server_vad' },
        },
      },
      { type: 'input_audio_buffer.append', audio: 'AAAA' },
    ],
  );
  assert.deepEqual(
    events.map((event) =>
      (event as { type: string; status?: string }).status
        ? [
            (event as { type: string }).type,
            (event as { status: string }).status,
          ]
        : [(event as { type: string }).type],
    ),
    [
      ['voice_transcript_status', 'connecting'],
      ['voice_transcript_status', 'recording'],
    ],
  );
});

test('VoiceTranscriptionService emits transcript events parsed from websocket messages', () => {
  const socket = new FakeSocket();
  const service = new VoiceTranscriptionService(env());
  service.setSocketFactoryForTesting(() => socket);
  const events: unknown[] = [];

  service.start('session-a', 'voice-2', {}, (event) => events.push(event));
  socket.dispatch('open', {});
  socket.dispatch('message', {
    data: JSON.stringify({
      type: 'conversation.item.input_audio_transcription.delta',
      delta: '你好',
    }),
  });
  socket.dispatch('message', {
    data: JSON.stringify({
      type: 'conversation.item.input_audio_transcription.completed',
      transcript: '你好世界',
    }),
  });

  assert.deepEqual(events.slice(2, 4), [
    {
      type: 'voice_transcript_delta',
      runId: 'voice-session-a',
      requestId: 'voice-2',
      text: '你好',
    },
    {
      type: 'voice_transcript_done',
      runId: 'voice-session-a',
      requestId: 'voice-2',
      text: '你好世界',
    },
  ]);
  assert.deepEqual(events.at(-1), {
    type: 'voice_transcript_status',
    runId: 'voice-session-a',
    requestId: 'voice-2',
    status: 'stopped',
  });
});
