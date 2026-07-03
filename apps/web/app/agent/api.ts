import type {
  CheckpointSessionResponse,
  ControlMessage,
  InstalledPlugin,
  ListCatalogPluginsResponse,
  ListCheckpointsResponse,
  ListInstalledPluginsResponse,
  ListMcpRegistryServersResponse,
  ListSessionsResponse,
  McpRegistryServerDetail,
  ModelConfig,
  ModelProtocol,
  PermissionMode,
  PluginKind,
  PluginTrust,
} from './types';

// The agent server base URL. Read at module load from the public env var with a
// localhost fallback so the page works out of the box in local dev.
export const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://127.0.0.1:3001';

async function postJson(path: string, body: unknown): Promise<Response> {
  const res = await fetch(`${API_BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(
      `${path} failed: ${String(res.status)} ${res.statusText}${
        detail ? ` — ${detail}` : ''
      }`,
    );
  }
  return res;
}

async function patchJson(path: string, body: unknown): Promise<Response> {
  const res = await fetch(`${API_BASE_URL}${path}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(
      `${path} failed: ${String(res.status)} ${res.statusText}${
        detail ? ` — ${detail}` : ''
      }`,
    );
  }
  return res;
}

async function deleteJson(path: string): Promise<Response> {
  const res = await fetch(`${API_BASE_URL}${path}`, {
    method: 'DELETE',
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(
      `${path} failed: ${String(res.status)} ${res.statusText}${
        detail ? ` — ${detail}` : ''
      }`,
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
      }`,
    );
  }
  return res;
}

export type CreateSessionRequest = {
  permissionMode?: PermissionMode;
  cwd?: string;
  workspaceRoots?: string[];
  watchWorkspace?: boolean;
  // The apiKey, if any, lives only inside `model` and is sent once here. It is
  // never persisted client-side or logged.
  model?: ModelConfig;
};

export type RestoreCheckpointRequest = {
  model?: ModelConfig;
};

export type PublicModelPreset = {
  id: string;
  label: string;
  protocol?: ModelProtocol;
  baseURL?: string;
  defaultModel?: string;
  requiresApiKey: true;
  requiresBaseURL: boolean;
  requiresModel: boolean;
};

export type ModelConnectionResult = {
  ok: true;
  protocol: ModelProtocol;
  model: string;
  sample?: string;
};

export type StartVoiceTranscriptionRequest = {
  requestId: string;
  apiKey?: string;
  model?: string;
  language?: 'en' | 'zh' | 'auto';
};

export type VoiceAudioChunkRequest = {
  audio: string;
  sampleRate: number;
  numChannels: number;
};

export type ListMcpRegistryServersRequest = {
  limit?: number;
  cursor?: string;
};

export type InstallPluginRequest = {
  kind?: PluginKind;
  registryName: string;
  version?: string;
};

export type UpdateInstalledPluginRequest = {
  enabled?: boolean;
  trust?: PluginTrust;
};

// POST /sessions -> { id }
export async function createSession(
  req: CreateSessionRequest,
): Promise<string> {
  const res = await postJson('/sessions', req);
  const data = (await res.json()) as { id?: unknown };
  if (typeof data.id !== 'string') {
    throw new Error('POST /sessions did not return a string id.');
  }
  return data.id;
}

// GET /sessions -> persisted session summaries.
export async function listSessions(): Promise<ListSessionsResponse> {
  const res = await getJson('/sessions');
  return (await res.json()) as ListSessionsResponse;
}

// POST /sessions/:id/messages { text }
export async function sendMessage(
  sessionId: string,
  text: string,
): Promise<void> {
  await postJson(`/sessions/${encodeURIComponent(sessionId)}/messages`, {
    text,
  });
}

// POST /sessions/:id/control { ...ControlMessage }
export async function sendControl(
  sessionId: string,
  message: ControlMessage,
): Promise<void> {
  await postJson(`/sessions/${encodeURIComponent(sessionId)}/control`, message);
}

export async function startVoiceTranscription(
  sessionId: string,
  req: StartVoiceTranscriptionRequest,
): Promise<void> {
  await postJson(`/sessions/${encodeURIComponent(sessionId)}/voice/start`, req);
}

export async function appendVoiceAudio(
  sessionId: string,
  chunk: VoiceAudioChunkRequest,
): Promise<void> {
  await postJson(
    `/sessions/${encodeURIComponent(sessionId)}/voice/audio`,
    chunk,
  );
}

export async function stopVoiceTranscription(sessionId: string): Promise<void> {
  await postJson(`/sessions/${encodeURIComponent(sessionId)}/voice/stop`, {});
}

// GET /sessions/:id/checkpoints -> { checkpoints, currentCheckpointId? }
export async function listCheckpoints(
  sessionId: string,
): Promise<ListCheckpointsResponse> {
  const res = await getJson(
    `/sessions/${encodeURIComponent(sessionId)}/checkpoints`,
  );
  return (await res.json()) as ListCheckpointsResponse;
}

// POST /sessions/:id/checkpoints/:checkpointId/restore -> { id, checkpointId }
export async function restoreCheckpoint(
  sessionId: string,
  checkpointId: string,
  req: RestoreCheckpointRequest = {},
): Promise<CheckpointSessionResponse> {
  const res = await postJson(
    `/sessions/${encodeURIComponent(sessionId)}/checkpoints/${encodeURIComponent(
      checkpointId,
    )}/restore`,
    req,
  );
  return (await res.json()) as CheckpointSessionResponse;
}

// POST /sessions/:id/restore -> { id }
export async function restoreSession(
  sessionId: string,
  req: RestoreCheckpointRequest = {},
): Promise<{ id: string }> {
  const res = await postJson(
    `/sessions/${encodeURIComponent(sessionId)}/restore`,
    req,
  );
  return (await res.json()) as { id: string };
}

// POST /sessions/:id/checkpoints/:checkpointId/fork -> { id, checkpointId }
export async function forkCheckpoint(
  sessionId: string,
  checkpointId: string,
  req: RestoreCheckpointRequest = {},
): Promise<CheckpointSessionResponse> {
  const res = await postJson(
    `/sessions/${encodeURIComponent(sessionId)}/checkpoints/${encodeURIComponent(
      checkpointId,
    )}/fork`,
    req,
  );
  return (await res.json()) as CheckpointSessionResponse;
}

// The SSE events endpoint URL for a given session.
export function eventsUrl(sessionId: string): string {
  return `${API_BASE_URL}/sessions/${encodeURIComponent(sessionId)}/events`;
}

// GET /models/presets -> adapter-backed model templates without secrets.
export async function listModelPresets(): Promise<PublicModelPreset[]> {
  const res = await getJson('/models/presets');
  const data = (await res.json()) as { presets?: PublicModelPreset[] };
  if (!Array.isArray(data.presets)) {
    throw new Error('GET /models/presets did not return a presets array.');
  }
  return data.presets;
}

// POST /models/test { model } -> probe the selected adapter config.
export async function testModelConfig(
  model: ModelConfig,
): Promise<ModelConnectionResult> {
  const res = await postJson('/models/test', { model });
  return (await res.json()) as ModelConnectionResult;
}

// POST /models/list { model } -> list OpenAI-compatible remote model ids.
export async function listRemoteModels(model: ModelConfig): Promise<string[]> {
  const res = await postJson('/models/list', { model });
  const data = (await res.json()) as { models?: unknown };
  if (!Array.isArray(data.models)) {
    throw new Error('POST /models/list did not return a models array.');
  }
  return data.models.filter((item): item is string => typeof item === 'string');
}

// GET /plugins/registry/mcp?limit=&cursor= -> registry MCP server summaries.
export async function listMcpRegistryServers(
  req: ListMcpRegistryServersRequest = {},
): Promise<ListMcpRegistryServersResponse> {
  const params = new URLSearchParams();
  if (typeof req.limit === 'number') params.set('limit', String(req.limit));
  if (req.cursor) params.set('cursor', req.cursor);
  const query = params.toString();
  const res = await getJson(`/plugins/registry/mcp${query ? `?${query}` : ''}`);
  return (await res.json()) as ListMcpRegistryServersResponse;
}

// GET /plugins/registry/mcp/:name -> registry MCP server detail.
export async function getMcpRegistryServer(
  name: string,
): Promise<McpRegistryServerDetail> {
  const res = await getJson(
    `/plugins/registry/mcp/${encodeURIComponent(name)}`,
  );
  return (await res.json()) as McpRegistryServerDetail;
}

// GET /plugins/registry/skills -> skill catalog plugin summaries.
export async function listSkillRegistryPlugins(): Promise<ListCatalogPluginsResponse> {
  const res = await getJson('/plugins/registry/skills');
  return (await res.json()) as ListCatalogPluginsResponse;
}

// GET /plugins/registry/lsp -> LSP catalog plugin summaries.
export async function listLspRegistryPlugins(): Promise<ListCatalogPluginsResponse> {
  const res = await getJson('/plugins/registry/lsp');
  return (await res.json()) as ListCatalogPluginsResponse;
}

// GET /plugins/installed -> installed plugin records.
export async function listInstalledPlugins(): Promise<ListInstalledPluginsResponse> {
  const res = await getJson('/plugins/installed');
  return (await res.json()) as ListInstalledPluginsResponse;
}

// POST /plugins/install { registryName, version? } -> installed plugin.
export async function installPlugin(
  req: InstallPluginRequest,
): Promise<InstalledPlugin> {
  const res = await postJson('/plugins/install', req);
  return (await res.json()) as InstalledPlugin;
}

// PATCH /plugins/installed/:id { enabled?, trust? } -> installed plugin.
export async function updateInstalledPlugin(
  id: string,
  req: UpdateInstalledPluginRequest,
): Promise<InstalledPlugin> {
  const res = await patchJson(
    `/plugins/installed/${encodeURIComponent(id)}`,
    req,
  );
  return (await res.json()) as InstalledPlugin;
}

// DELETE /plugins/installed/:id -> 204.
export async function deleteInstalledPlugin(id: string): Promise<void> {
  await deleteJson(`/plugins/installed/${encodeURIComponent(id)}`);
}
