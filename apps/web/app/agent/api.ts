import type {
  CheckpointSessionResponse,
  ControlMessage,
  ListCheckpointsResponse,
  ModelConfig,
  PermissionMode,
} from './types';

// The agent server base URL. Read at module load from the public env var with a
// localhost fallback so the page works out of the box in local dev.
export const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:3001';

async function postJson(path: string, body: unknown): Promise<Response> {
  const res = await fetch(`${API_BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(
      `${path} failed: ${String(res.status)} ${res.statusText}${
        detail ? ` — ${detail}` : ''
      }`
    );
  }
  return res;
}

async function getJson(path: string): Promise<Response> {
  const res = await fetch(`${API_BASE_URL}${path}`);
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(
      `${path} failed: ${String(res.status)} ${res.statusText}${
        detail ? ` — ${detail}` : ''
      }`
    );
  }
  return res;
}

export type CreateSessionRequest = {
  permissionMode?: PermissionMode;
  watchWorkspace?: boolean;
  // The apiKey, if any, lives only inside `model` and is sent once here. It is
  // never persisted client-side or logged.
  model?: ModelConfig;
};

export type RestoreCheckpointRequest = {
  model?: ModelConfig;
};

// POST /sessions -> { id }
export async function createSession(
  req: CreateSessionRequest
): Promise<string> {
  const res = await postJson('/sessions', req);
  const data = (await res.json()) as { id?: unknown };
  if (typeof data.id !== 'string') {
    throw new Error('POST /sessions did not return a string id.');
  }
  return data.id;
}

// POST /sessions/:id/messages { text }
export async function sendMessage(
  sessionId: string,
  text: string
): Promise<void> {
  await postJson(`/sessions/${encodeURIComponent(sessionId)}/messages`, {
    text
  });
}

// POST /sessions/:id/control { ...ControlMessage }
export async function sendControl(
  sessionId: string,
  message: ControlMessage
): Promise<void> {
  await postJson(`/sessions/${encodeURIComponent(sessionId)}/control`, message);
}

// GET /sessions/:id/checkpoints -> { checkpoints, currentCheckpointId? }
export async function listCheckpoints(
  sessionId: string
): Promise<ListCheckpointsResponse> {
  const res = await getJson(
    `/sessions/${encodeURIComponent(sessionId)}/checkpoints`
  );
  return (await res.json()) as ListCheckpointsResponse;
}

// POST /sessions/:id/checkpoints/:checkpointId/restore -> { id, checkpointId }
export async function restoreCheckpoint(
  sessionId: string,
  checkpointId: string,
  req: RestoreCheckpointRequest = {}
): Promise<CheckpointSessionResponse> {
  const res = await postJson(
    `/sessions/${encodeURIComponent(sessionId)}/checkpoints/${encodeURIComponent(
      checkpointId
    )}/restore`,
    req
  );
  return (await res.json()) as CheckpointSessionResponse;
}

// POST /sessions/:id/checkpoints/:checkpointId/fork -> { id, checkpointId }
export async function forkCheckpoint(
  sessionId: string,
  checkpointId: string,
  req: RestoreCheckpointRequest = {}
): Promise<CheckpointSessionResponse> {
  const res = await postJson(
    `/sessions/${encodeURIComponent(sessionId)}/checkpoints/${encodeURIComponent(
      checkpointId
    )}/fork`,
    req
  );
  return (await res.json()) as CheckpointSessionResponse;
}

// The SSE events endpoint URL for a given session.
export function eventsUrl(sessionId: string): string {
  return `${API_BASE_URL}/sessions/${encodeURIComponent(sessionId)}/events`;
}
