type TauriWindow = {
  __TAURI_INTERNALS__?: unknown;
};

type SpeechRecognitionTarget = TauriWindow & {
  SpeechRecognition?: unknown;
  webkitSpeechRecognition?: unknown;
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

export type MacosSpeechEvent = {
  kind: 'status' | 'delta' | 'done' | 'error';
  text: string;
};

export function isTauriRuntime(target: unknown = globalThis): boolean {
  return (
    typeof target === 'object' &&
    target !== null &&
    '__TAURI_INTERNALS__' in target
  );
}

export function canUseMacosSpeech(target: unknown = globalThis): boolean {
  return isTauriRuntime(target);
}

export function canUseBrowserSpeechRecognition(
  target: unknown = globalThis,
): boolean {
  if (isTauriRuntime(target)) return false;
  if (typeof target !== 'object' || target === null) return false;

  const candidate = target as SpeechRecognitionTarget;
  return Boolean(candidate.SpeechRecognition ?? candidate.webkitSpeechRecognition);
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

export async function startMacosSpeech(language: string): Promise<boolean> {
  if (!canUseMacosSpeech()) return false;
  const api = await import('@tauri-apps/api/core');
  await api.invoke('macos_speech_start', { language });
  return true;
}

export async function stopMacosSpeech(): Promise<void> {
  if (!canUseMacosSpeech()) return;
  const api = await import('@tauri-apps/api/core');
  await api.invoke('macos_speech_stop');
}

export async function listenMacosSpeech(
  handler: (event: MacosSpeechEvent) => void,
): Promise<() => void> {
  if (!canUseMacosSpeech()) return () => {};
  const api = await import('@tauri-apps/api/event');
  return await api.listen<MacosSpeechEvent>('macos_speech://event', (event) =>
    handler(event.payload),
  );
}

export type { TauriWindow };
