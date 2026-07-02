type TauriWindow = {
  __TAURI_INTERNALS__?: unknown;
};

export type AgentServerStatus = {
  running: boolean;
  managed: boolean;
  baseUrl: string;
};

export type PickedFile = {
  name: string;
  path: string;
};

export function isTauriRuntime(target: unknown = globalThis): boolean {
  return (
    typeof target === 'object' &&
    target !== null &&
    '__TAURI_INTERNALS__' in target
  );
}

export async function pickWorkspaceDirectory(): Promise<string | null> {
  if (!isTauriRuntime()) return null;
  const api = await import('@tauri-apps/api/core');
  return await api.invoke<string | null>('pick_workspace_directory');
}

export async function pickUploadFile(): Promise<PickedFile | null> {
  if (!isTauriRuntime()) return null;
  const api = await import('@tauri-apps/api/core');
  return await api.invoke<PickedFile | null>('pick_upload_file');
}

export async function ensureAgentServer(): Promise<AgentServerStatus | null> {
  if (!isTauriRuntime()) return null;
  const api = await import('@tauri-apps/api/core');
  return await api.invoke<AgentServerStatus>('ensure_agent_server');
}

export async function agentServerStatus(): Promise<AgentServerStatus | null> {
  if (!isTauriRuntime()) return null;
  const api = await import('@tauri-apps/api/core');
  return await api.invoke<AgentServerStatus>('agent_server_status');
}

export type { TauriWindow };
