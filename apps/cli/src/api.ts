import type { CreateSessionBody } from './args';
import { parseSseChunk } from './sse';

export type SessionEvent = Record<string, unknown> & { type?: string };

export async function createSession(
  apiBaseUrl: string,
  body: CreateSessionBody
): Promise<string> {
  const response = await fetch(`${apiBaseUrl}/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  const payload = await readJson(response);
  if (!response.ok) {
    throw new Error(formatHttpError('create session', response, payload));
  }
  const id = (payload as { id?: unknown }).id;
  if (typeof id !== 'string') {
    throw new Error('create session response did not include a string id.');
  }
  return id;
}

export async function sendMessage(
  apiBaseUrl: string,
  sessionId: string,
  text: string
): Promise<void> {
  await postJson(apiBaseUrl, `/sessions/${sessionId}/messages`, { text });
}

export async function sendControl(
  apiBaseUrl: string,
  sessionId: string,
  message: Record<string, unknown>
): Promise<void> {
  await postJson(apiBaseUrl, `/sessions/${sessionId}/control`, message);
}

export async function* streamSessionEvents(
  apiBaseUrl: string,
  sessionId: string,
  signal?: AbortSignal
): AsyncIterable<SessionEvent> {
  const response = await fetch(`${apiBaseUrl}/sessions/${sessionId}/events`, {
    headers: { accept: 'text/event-stream' },
    signal
  });
  if (!response.ok || !response.body) {
    const payload = await readJson(response);
    throw new Error(formatHttpError('open event stream', response, payload));
  }

  const reader = response.body
    .pipeThrough(new TextDecoderStream())
    .getReader();
  let remainder = '';
  try {
    for (;;) {
      const read = await reader.read();
      if (read.done) {
        return;
      }
      const parsed = parseSseChunk(remainder, read.value);
      remainder = parsed.remainder;
      for (const event of parsed.events) {
        if (isSessionEvent(event)) {
          yield event;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

async function postJson(
  apiBaseUrl: string,
  path: string,
  body: Record<string, unknown>
): Promise<void> {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    const payload = await readJson(response);
    throw new Error(formatHttpError(path, response, payload));
  }
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function formatHttpError(
  action: string,
  response: Response,
  payload: unknown
): string {
  const message =
    typeof payload === 'object' &&
    payload !== null &&
    typeof (payload as { message?: unknown }).message === 'string'
      ? (payload as { message: string }).message
      : response.statusText;
  return `Failed to ${action}: ${String(response.status)} ${message}`;
}

function isSessionEvent(value: unknown): value is SessionEvent {
  return typeof value === 'object' && value !== null;
}
