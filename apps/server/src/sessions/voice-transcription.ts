import { Inject, Injectable, BadRequestException } from '@nestjs/common';
import type { SessionEvent } from '@colorful-code/tool-runtime';
import { SERVER_ENV } from '../config/config.module';
import type { ServerEnvironment } from '../config/environment';

export type VoiceStartOptions = {
  apiKey?: string;
  model?: string;
  language?: 'en' | 'zh' | 'auto';
};

export type VoiceAudioChunk = {
  audio: string;
  sampleRate: number;
  numChannels: number;
};

export type VoiceEventWithoutRunId =
  | { type: 'voice_transcript_status'; status: 'connecting' | 'recording' | 'stopped' }
  | { type: 'voice_transcript_delta'; text: string }
  | { type: 'voice_transcript_done'; text: string }
  | { type: 'voice_transcript_error'; message: string };

type VoiceEmitter = (event: SessionEvent) => void;

type RealtimeSocketEvent = {
  data?: unknown;
  message?: unknown;
  error?: unknown;
};

export type RealtimeSocket = {
  readyState?: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener?: (
    type: 'open' | 'message' | 'error' | 'close',
    listener: (event: RealtimeSocketEvent) => void,
  ) => void;
  onopen?: (event: RealtimeSocketEvent) => void;
  onmessage?: (event: RealtimeSocketEvent) => void;
  onerror?: (event: RealtimeSocketEvent) => void;
  onclose?: (event: RealtimeSocketEvent) => void;
};

export type RealtimeSocketFactory = (
  url: string,
  options: { headers: Record<string, string> },
) => RealtimeSocket;

export const DEFAULT_REALTIME_TRANSCRIPTION_MODEL = 'gpt-4o-mini-transcribe';

type VoiceConnection = {
  requestId: string;
  socket: RealtimeSocket;
  emit: VoiceEmitter;
  ready: boolean;
  closed: boolean;
  pendingAudio: string[];
  closeTimer?: ReturnType<typeof setTimeout>;
};

function defaultRealtimeSocketFactory(
  url: string,
  options: { headers: Record<string, string> },
): RealtimeSocket {
  const SocketCtor = (
    globalThis as unknown as {
      WebSocket?: new (
        url: string,
        options?: { headers?: Record<string, string> },
      ) => RealtimeSocket;
    }
  ).WebSocket;
  if (!SocketCtor) {
    throw new Error('WebSocket is not available in this runtime.');
  }
  return new SocketCtor(url, options);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readText(value: Record<string, unknown>): string | undefined {
  for (const key of ['delta', 'transcript', 'text']) {
    if (typeof value[key] === 'string' && value[key].length > 0) {
      return value[key];
    }
  }
  return undefined;
}

function readErrorMessage(value: Record<string, unknown>): string {
  const error = value.error;
  if (isPlainObject(error) && typeof error.message === 'string') {
    return error.message;
  }
  if (typeof value.message === 'string') {
    return value.message;
  }
  return JSON.stringify(value);
}

export function parseRealtimeTranscriptionEvent(
  value: unknown,
): VoiceEventWithoutRunId | null {
  if (!isPlainObject(value) || typeof value.type !== 'string') {
    return null;
  }

  if (value.type === 'error') {
    return {
      type: 'voice_transcript_error',
      message: readErrorMessage(value),
    };
  }

  if (
    value.type.endsWith('.input_audio_transcription.delta') ||
    value.type === 'transcription.delta'
  ) {
    const text = readText(value);
    return text ? { type: 'voice_transcript_delta', text } : null;
  }

  if (
    value.type.endsWith('.input_audio_transcription.completed') ||
    value.type.endsWith('.input_audio_transcription.done') ||
    value.type === 'transcription.done'
  ) {
    const text = readText(value);
    return text ? { type: 'voice_transcript_done', text } : null;
  }

  if (
    value.type.endsWith('.input_audio_transcription.failed') ||
    value.type === 'transcription.error'
  ) {
    return {
      type: 'voice_transcript_error',
      message: readErrorMessage(value),
    };
  }

  return null;
}

export function validateVoiceAudioChunk(value: unknown): VoiceAudioChunk {
  if (!isPlainObject(value)) {
    throw new BadRequestException('voice audio body must be an object.');
  }
  if (typeof value.audio !== 'string' || value.audio.length === 0) {
    throw new BadRequestException('voice audio requires non-empty `audio`.');
  }
  if (
    typeof value.sampleRate !== 'number' ||
    !Number.isInteger(value.sampleRate) ||
    value.sampleRate <= 0
  ) {
    throw new BadRequestException('voice audio requires integer `sampleRate`.');
  }
  if (
    typeof value.numChannels !== 'number' ||
    !Number.isInteger(value.numChannels) ||
    value.numChannels <= 0
  ) {
    throw new BadRequestException('voice audio requires integer `numChannels`.');
  }
  return {
    audio: value.audio,
    sampleRate: value.sampleRate,
    numChannels: value.numChannels,
  };
}

export function validateVoiceStartOptions(value: unknown): VoiceStartOptions {
  if (value === undefined || value === null) {
    return {};
  }
  if (!isPlainObject(value)) {
    throw new BadRequestException('voice start body must be an object.');
  }
  const options: VoiceStartOptions = {};
  if (value.apiKey !== undefined) {
    if (typeof value.apiKey !== 'string') {
      throw new BadRequestException('voice start `apiKey` must be a string.');
    }
    options.apiKey = value.apiKey;
  }
  if (value.model !== undefined) {
    if (typeof value.model !== 'string') {
      throw new BadRequestException('voice start `model` must be a string.');
    }
    options.model = value.model;
  }
  if (value.language !== undefined) {
    if (
      value.language !== 'en' &&
      value.language !== 'zh' &&
      value.language !== 'auto'
    ) {
      throw new BadRequestException(
        "voice start `language` must be 'en', 'zh', or 'auto'.",
      );
    }
    options.language = value.language;
  }
  return options;
}

@Injectable()
export class VoiceTranscriptionService {
  private readonly connections = new Map<string, VoiceConnection>();
  private socketFactory: RealtimeSocketFactory = defaultRealtimeSocketFactory;

  constructor(
    @Inject(SERVER_ENV) private readonly env: ServerEnvironment,
  ) {}

  setSocketFactoryForTesting(socketFactory: RealtimeSocketFactory): void {
    this.socketFactory = socketFactory;
  }

  start(
    sessionId: string,
    requestId: string,
    options: VoiceStartOptions,
    emit: VoiceEmitter,
  ): void {
    this.stop(sessionId);
    const apiKey = options.apiKey?.trim() || this.env.providerKeys.openai;
    if (!apiKey) {
      throw new BadRequestException(
        'Voice transcription requires an OpenAI API key.',
      );
    }

    const model = options.model?.trim() || DEFAULT_REALTIME_TRANSCRIPTION_MODEL;
    const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(
      model,
    )}`;
    const socket = this.socketFactory(url, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'OpenAI-Beta': 'realtime=v1',
      },
    });
    const connection: VoiceConnection = {
      requestId,
      socket,
      emit,
      ready: false,
      closed: false,
      pendingAudio: [],
    };
    this.connections.set(sessionId, connection);
    this.emit(sessionId, connection, {
      type: 'voice_transcript_status',
      status: 'connecting',
    });

    this.listen(socket, 'open', () => {
      connection.ready = true;
      this.sendSessionUpdate(connection, options);
      this.flushPendingAudio(connection);
      this.emit(sessionId, connection, {
        type: 'voice_transcript_status',
        status: 'recording',
      });
    });
    this.listen(socket, 'message', (event) => {
      const data = event.data ?? event.message;
      const parsed = this.parseSocketData(data);
      const voiceEvent = parseRealtimeTranscriptionEvent(parsed);
      if (voiceEvent) {
        this.emit(sessionId, connection, voiceEvent);
        if (
          voiceEvent.type === 'voice_transcript_done' ||
          voiceEvent.type === 'voice_transcript_error'
        ) {
          this.closeConnection(connection);
        }
      }
    });
    this.listen(socket, 'error', (event) => {
      const message =
        event.error instanceof Error ? event.error.message : 'Voice socket error.';
      this.emit(sessionId, connection, {
        type: 'voice_transcript_error',
        message,
      });
    });
    this.listen(socket, 'close', () => {
      connection.closed = true;
      this.emit(sessionId, connection, {
        type: 'voice_transcript_status',
        status: 'stopped',
      });
    });
  }

  appendAudio(sessionId: string, chunk: VoiceAudioChunk): void {
    const connection = this.connections.get(sessionId);
    if (!connection || connection.closed) {
      throw new BadRequestException('Voice transcription has not started.');
    }
    if (connection.ready) {
      this.sendAudio(connection, chunk.audio);
    } else {
      connection.pendingAudio.push(chunk.audio);
    }
  }

  stop(sessionId: string): void {
    const connection = this.connections.get(sessionId);
    if (!connection) {
      return;
    }
    this.connections.delete(sessionId);
    try {
      if (connection.ready && !connection.closed) {
        connection.socket.send(
          JSON.stringify({ type: 'input_audio_buffer.commit' }),
        );
        connection.closeTimer = setTimeout(() => {
          this.closeConnection(connection);
        }, 5_000);
        return;
      }
    } catch {
      // Best effort: stopping should still close local resources.
    }
    this.closeConnection(connection);
  }

  private closeConnection(connection: VoiceConnection): void {
    if (connection.closeTimer) {
      clearTimeout(connection.closeTimer);
      connection.closeTimer = undefined;
    }
    if (connection.closed) {
      return;
    }
    try {
      connection.socket.close(1000, 'voice transcription stopped');
    } catch {
      // Best effort close.
    }
  }

  private emit(
    sessionId: string,
    connection: VoiceConnection,
    event: VoiceEventWithoutRunId,
  ): void {
    connection.emit({
      ...event,
      runId: `voice-${sessionId}`,
      requestId: connection.requestId,
    } as unknown as SessionEvent);
  }

  private listen(
    socket: RealtimeSocket,
    type: 'open' | 'message' | 'error' | 'close',
    listener: (event: RealtimeSocketEvent) => void,
  ): void {
    if (socket.addEventListener) {
      socket.addEventListener(type, listener);
      return;
    }
    if (type === 'open') socket.onopen = listener;
    if (type === 'message') socket.onmessage = listener;
    if (type === 'error') socket.onerror = listener;
    if (type === 'close') socket.onclose = listener;
  }

  private parseSocketData(data: unknown): unknown {
    if (typeof data === 'string') {
      try {
        return JSON.parse(data);
      } catch {
        return null;
      }
    }
    if (data instanceof Buffer) {
      try {
        return JSON.parse(data.toString('utf8'));
      } catch {
        return null;
      }
    }
    return data;
  }

  private sendSessionUpdate(
    connection: VoiceConnection,
    options: VoiceStartOptions,
  ): void {
    const language =
      options.language && options.language !== 'auto'
        ? options.language === 'zh'
          ? 'zh'
          : 'en'
        : undefined;
    connection.socket.send(
      JSON.stringify({
        type: 'session.update',
        session: {
          input_audio_format: 'pcm16',
          input_audio_transcription: {
            model: DEFAULT_REALTIME_TRANSCRIPTION_MODEL,
            ...(language ? { language } : {}),
          },
          turn_detection: { type: 'server_vad' },
        },
      }),
    );
  }

  private flushPendingAudio(connection: VoiceConnection): void {
    for (const audio of connection.pendingAudio.splice(0)) {
      this.sendAudio(connection, audio);
    }
  }

  private sendAudio(connection: VoiceConnection, audio: string): void {
    connection.socket.send(
      JSON.stringify({ type: 'input_audio_buffer.append', audio }),
    );
  }
}
