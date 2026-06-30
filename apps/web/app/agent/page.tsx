'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react';
import { Button } from '@/components/ui/button';
import {
  API_BASE_URL,
  createSession,
  eventsUrl,
  sendControl,
  sendMessage
} from './api';
import {
  PERMISSION_MODES,
  SESSION_EVENT_TYPES,
  type JsonObject,
  type ModelConfig,
  type ModelProtocol,
  type PermissionMode,
  type RunStatus,
  type SessionEvent
} from './types';

// ---- Model presets -------------------------------------------------------

type Preset = {
  id: string;
  label: string;
  protocol: ModelProtocol;
};

// "custom" exposes protocol/baseURL/model/apiKey fields; the named presets let
// the server fall back to its own baseURL/model defaults.
const PRESETS: readonly Preset[] = [
  { id: 'claude', label: 'Claude', protocol: 'anthropic' },
  { id: 'deepseek', label: 'DeepSeek', protocol: 'openai' },
  { id: 'openai', label: 'OpenAI', protocol: 'openai' },
  { id: 'custom', label: 'Custom', protocol: 'openai' }
];

// ---- Derived conversation model -----------------------------------------

type ConversationItem =
  | { kind: 'assistant'; runId: string; text: string; finalized: boolean }
  | {
      kind: 'tool';
      toolUseId: string;
      name: string;
      input: JsonObject;
      result?: { content: string; isError: boolean };
    };

type LoggedEvent = { seq: number; event: SessionEvent };

type ApprovalState = {
  requestId: string;
  toolUseId: string;
  name: string;
  input: JsonObject;
  message: string;
};

// ---- Small presentational helpers ---------------------------------------

const fieldLabel =
  'text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground';

const inputClass =
  'h-9 w-full rounded-lg border border-border bg-background px-3 text-sm text-foreground outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30 disabled:opacity-50';

const selectClass = inputClass;

const panelClass =
  'flex min-h-0 flex-col rounded-[1.4rem] border border-border/70 bg-card/85 p-4 shadow-sm';

function Json({ value }: { value: unknown }): ReactNode {
  return (
    <pre className="overflow-x-auto whitespace-pre-wrap break-words font-mono text-xs leading-5 text-foreground/85">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

function statusTone(status: RunStatus | null): string {
  switch (status) {
    case 'running':
      return 'border-primary/40 text-foreground';
    case 'completed':
      return 'border-border text-muted-foreground';
    case 'cancelled':
      return 'border-border text-muted-foreground';
    case 'error':
      return 'border-destructive/40 text-destructive';
    default:
      return 'border-border text-muted-foreground';
  }
}

// ---- Page ----------------------------------------------------------------

export default function AgentDebugPage(): ReactNode {
  // Session creation controls.
  const [presetId, setPresetId] = useState<string>('claude');
  const [permissionMode, setPermissionMode] =
    useState<PermissionMode>('default');
  const [customProtocol, setCustomProtocol] =
    useState<ModelProtocol>('openai');
  const [customBaseURL, setCustomBaseURL] = useState('');
  const [customModel, setCustomModel] = useState('');
  const [customApiKey, setCustomApiKey] = useState('');

  // Live session state.
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [connected, setConnected] = useState(false);
  const [runStatus, setRunStatus] = useState<RunStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Conversation + raw log + approvals derived from the SSE stream.
  const [items, setItems] = useState<ConversationItem[]>([]);
  const [log, setLog] = useState<LoggedEvent[]>([]);
  const [approval, setApproval] = useState<ApprovalState | null>(null);

  // Message composer.
  const [draft, setDraft] = useState('');

  const sourceRef = useRef<EventSource | null>(null);
  const seqRef = useRef(0);
  const conversationEndRef = useRef<HTMLDivElement | null>(null);

  const preset = useMemo(
    () => PRESETS.find((p) => p.id === presetId) ?? PRESETS[0],
    [presetId]
  );
  const isCustom = preset.id === 'custom';

  // Fold each incoming event into the conversation + raw log.
  const handleEvent = useCallback((event: SessionEvent) => {
    seqRef.current += 1;
    const seq = seqRef.current;
    setLog((prev) => [...prev, { seq, event }]);

    switch (event.type) {
      case 'run_status':
        setRunStatus(event.status);
        break;
      case 'message_delta':
        setItems((prev) => appendDelta(prev, event.runId, event.text));
        break;
      case 'message':
        setItems((prev) => finalizeMessage(prev, event.runId, event.content));
        break;
      case 'tool_call':
        setItems((prev) => [
          ...prev,
          {
            kind: 'tool',
            toolUseId: event.toolUseId,
            name: event.name,
            input: event.input
          }
        ]);
        break;
      case 'tool_result':
        setItems((prev) =>
          attachResult(prev, event.toolUseId, {
            content: event.content,
            isError: event.isError ?? false
          })
        );
        break;
      case 'approval_required':
        setApproval({
          requestId: event.requestId,
          toolUseId: event.toolUseId,
          name: event.name,
          input: event.input,
          message: event.message
        });
        break;
      case 'error':
        setError(event.message);
        break;
      // permission_decision / todos_updated are surfaced via the raw log only.
      default:
        break;
    }
  }, []);

  // Open the SSE stream for a session. The server replays its buffer on connect,
  // so this is reconnect-safe; we connect right after create, before sending.
  const openStream = useCallback(
    (id: string) => {
      sourceRef.current?.close();
      const source = new EventSource(eventsUrl(id));
      sourceRef.current = source;

      source.onopen = (): void => {
        setConnected(true);
      };
      source.onerror = (): void => {
        // EventSource auto-reconnects; reflect the transient drop in the UI.
        setConnected(false);
      };
      // Each event carries a named SSE `event:` field, so onmessage never fires.
      // Register one listener per event type instead.
      for (const type of SESSION_EVENT_TYPES) {
        source.addEventListener(type, (raw: MessageEvent<string>) => {
          try {
            const parsed = JSON.parse(raw.data) as SessionEvent;
            handleEvent(parsed);
          } catch {
            setError(`Failed to parse ${type} event payload.`);
          }
        });
      }
    },
    [handleEvent]
  );

  const closeStream = useCallback(() => {
    sourceRef.current?.close();
    sourceRef.current = null;
    setConnected(false);
  }, []);

  useEffect(() => closeStream, [closeStream]);

  // Auto-scroll the conversation as items grow.
  useEffect(() => {
    conversationEndRef.current?.scrollIntoView({ block: 'end' });
  }, [items]);

  const buildModelConfig = useCallback((): ModelConfig | undefined => {
    if (!isCustom) {
      return { preset: preset.id };
    }
    // Custom preset: send only the fields the user actually filled in. apiKey is
    // sent only here, in the create request body.
    const config: ModelConfig = { preset: 'custom', protocol: customProtocol };
    if (customBaseURL.trim()) config.baseURL = customBaseURL.trim();
    if (customModel.trim()) config.model = customModel.trim();
    if (customApiKey) config.apiKey = customApiKey;
    return config;
  }, [
    isCustom,
    preset.id,
    customProtocol,
    customBaseURL,
    customModel,
    customApiKey
  ]);

  const handleCreate = useCallback(async () => {
    setError(null);
    setConnecting(true);
    try {
      const id = await createSession({
        permissionMode,
        model: buildModelConfig()
      });
      // Reset derived state for the fresh session.
      setItems([]);
      setLog([]);
      setApproval(null);
      setRunStatus(null);
      seqRef.current = 0;
      setSessionId(id);
      // Connect promptly so no events are missed (buffer replay covers the gap).
      openStream(id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setConnecting(false);
    }
  }, [permissionMode, buildModelConfig, openStream]);

  const handleSend = useCallback(async () => {
    if (!sessionId || !draft.trim()) return;
    const text = draft;
    setDraft('');
    try {
      await sendMessage(sessionId, text);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [sessionId, draft]);

  const handleApprovalDecision = useCallback(
    async (allow: boolean) => {
      if (!sessionId || !approval) return;
      const { requestId } = approval;
      setApproval(null);
      try {
        await sendControl(sessionId, {
          type: 'approval_response',
          requestId,
          decision: allow
            ? { behavior: 'allow' }
            : { behavior: 'deny', message: 'Denied from debug UI.' }
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [sessionId, approval]
  );

  const handleSetMode = useCallback(
    async (mode: PermissionMode) => {
      setPermissionMode(mode);
      if (!sessionId) return;
      try {
        await sendControl(sessionId, { type: 'set_permission_mode', mode });
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [sessionId]
  );

  const handleCancel = useCallback(async () => {
    if (!sessionId) return;
    try {
      await sendControl(sessionId, { type: 'cancel' });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [sessionId]);

  const hasSession = sessionId !== null;

  return (
    <main className="min-h-screen bg-background px-4 py-6 text-foreground sm:px-6 sm:py-8">
      <div className="mx-auto flex max-w-6xl flex-col gap-5">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.28em] text-muted-foreground">
              Colorful Code
            </p>
            <h1 className="mt-1 text-2xl font-semibold tracking-tight">
              Agent Debug Console
            </h1>
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="font-mono">{API_BASE_URL}</span>
            <span
              className={`rounded-full border px-2 py-0.5 ${
                connected
                  ? 'border-primary/40 text-foreground'
                  : 'border-border text-muted-foreground'
              }`}
            >
              {hasSession
                ? connected
                  ? 'stream connected'
                  : 'stream offline'
                : 'no session'}
            </span>
          </div>
        </header>

        {error ? (
          <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {error}
          </div>
        ) : null}

        {/* Session controls */}
        <section className={panelClass}>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <label className="flex flex-col gap-1.5">
              <span className={fieldLabel}>Model preset</span>
              <select
                className={selectClass}
                value={presetId}
                disabled={hasSession}
                onChange={(e) => setPresetId(e.target.value)}
              >
                {PRESETS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="flex flex-col gap-1.5">
              <span className={fieldLabel}>Permission mode</span>
              <select
                className={selectClass}
                value={permissionMode}
                onChange={(e) =>
                  void handleSetMode(e.target.value as PermissionMode)
                }
              >
                {PERMISSION_MODES.map((mode) => (
                  <option key={mode} value={mode}>
                    {mode}
                  </option>
                ))}
              </select>
            </label>

            <div className="flex items-end gap-2 sm:col-span-2 lg:col-span-2">
              <Button
                onClick={() => void handleCreate()}
                disabled={connecting}
              >
                {hasSession ? 'New session' : 'Create session'}
              </Button>
              <Button
                variant="destructive"
                onClick={() => void handleCancel()}
                disabled={!hasSession || runStatus !== 'running'}
              >
                Cancel run
              </Button>
              {hasSession ? (
                <span className="ml-1 self-center font-mono text-xs text-muted-foreground">
                  {sessionId}
                </span>
              ) : null}
            </div>
          </div>

          {isCustom ? (
            <div className="mt-4 grid gap-4 border-t border-border/70 pt-4 sm:grid-cols-2 lg:grid-cols-4">
              <label className="flex flex-col gap-1.5">
                <span className={fieldLabel}>Protocol</span>
                <select
                  className={selectClass}
                  value={customProtocol}
                  disabled={hasSession}
                  onChange={(e) =>
                    setCustomProtocol(e.target.value as ModelProtocol)
                  }
                >
                  <option value="openai">openai</option>
                  <option value="anthropic">anthropic</option>
                </select>
              </label>
              <label className="flex flex-col gap-1.5">
                <span className={fieldLabel}>Base URL</span>
                <input
                  className={inputClass}
                  placeholder="https://api.example.com"
                  value={customBaseURL}
                  disabled={hasSession}
                  onChange={(e) => setCustomBaseURL(e.target.value)}
                />
              </label>
              <label className="flex flex-col gap-1.5">
                <span className={fieldLabel}>Model</span>
                <input
                  className={inputClass}
                  placeholder="model-id"
                  value={customModel}
                  disabled={hasSession}
                  onChange={(e) => setCustomModel(e.target.value)}
                />
              </label>
              <label className="flex flex-col gap-1.5">
                <span className={fieldLabel}>API key</span>
                <input
                  className={inputClass}
                  type="password"
                  autoComplete="off"
                  placeholder="sent once, never stored"
                  value={customApiKey}
                  disabled={hasSession}
                  onChange={(e) => setCustomApiKey(e.target.value)}
                />
              </label>
            </div>
          ) : null}
        </section>

        {/* Message composer */}
        <section className={panelClass}>
          <div className="flex items-end gap-2">
            <label className="flex flex-1 flex-col gap-1.5">
              <span className={fieldLabel}>Message</span>
              <input
                className={inputClass}
                placeholder={
                  hasSession
                    ? 'Send a message to the agent…'
                    : 'Create a session first'
                }
                value={draft}
                disabled={!hasSession}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void handleSend();
                }}
              />
            </label>
            <Button
              onClick={() => void handleSend()}
              disabled={!hasSession || !draft.trim()}
            >
              Send
            </Button>
          </div>
        </section>

        {/* Live view + raw log */}
        <section className="grid min-h-0 gap-5 lg:grid-cols-2">
          {/* Conversation */}
          <div className={`${panelClass} max-h-[60vh]`}>
            <div className="flex items-center justify-between gap-2 pb-3">
              <h2 className="text-sm font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                Conversation
              </h2>
              <span
                className={`rounded-full border px-2 py-0.5 text-xs ${statusTone(
                  runStatus
                )}`}
              >
                {runStatus ?? 'idle'}
              </span>
            </div>
            <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
              {items.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No messages yet.
                </p>
              ) : (
                items.map((item, index) =>
                  item.kind === 'assistant' ? (
                    <div
                      key={`a-${item.runId}-${String(index)}`}
                      className="rounded-xl border border-border/70 bg-background/70 px-3 py-2"
                    >
                      <p className="mb-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                        assistant{item.finalized ? '' : ' · streaming'}
                      </p>
                      <p className="whitespace-pre-wrap text-sm leading-6">
                        {item.text || '…'}
                      </p>
                    </div>
                  ) : (
                    <div
                      key={`t-${item.toolUseId}`}
                      className="rounded-xl border border-border/70 bg-background/70 px-3 py-2"
                    >
                      <p className="mb-1 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                        tool · {item.name}
                        {item.result ? (
                          <span
                            className={
                              item.result.isError
                                ? 'text-destructive'
                                : 'text-foreground/60'
                            }
                          >
                            {item.result.isError ? 'error' : 'done'}
                          </span>
                        ) : (
                          <span className="text-foreground/60">running</span>
                        )}
                      </p>
                      <Json value={item.input} />
                      {item.result ? (
                        <div className="mt-2 border-t border-border/60 pt-2">
                          <p className="mb-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                            result
                          </p>
                          <pre className="overflow-x-auto whitespace-pre-wrap break-words font-mono text-xs leading-5 text-foreground/85">
                            {item.result.content}
                          </pre>
                        </div>
                      ) : null}
                    </div>
                  )
                )
              )}
              <div ref={conversationEndRef} />
            </div>
          </div>

          {/* Raw event log */}
          <div className={`${panelClass} max-h-[60vh]`}>
            <div className="flex items-center justify-between gap-2 pb-3">
              <h2 className="text-sm font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                Raw event log
              </h2>
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">
                  {log.length} events
                </span>
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={() => setLog([])}
                  disabled={log.length === 0}
                >
                  Clear
                </Button>
              </div>
            </div>
            <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
              {log.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  Events will appear here as they stream in.
                </p>
              ) : (
                log.map((entry) => (
                  <div
                    key={entry.seq}
                    className="rounded-lg border border-border/60 bg-background/60 px-3 py-2"
                  >
                    <p className="mb-1 font-mono text-[11px] text-muted-foreground">
                      #{entry.seq} · {entry.event.type}
                    </p>
                    <Json value={entry.event} />
                  </div>
                ))
              )}
            </div>
          </div>
        </section>
      </div>

      {/* Approval modal */}
      {approval ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/40 p-4 backdrop-blur-sm">
          <div className="w-full max-w-lg rounded-[1.4rem] border border-border bg-card p-6 shadow-[0_30px_120px_-40px_rgba(0,0,0,0.5)]">
            <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-muted-foreground">
              Approval required
            </p>
            <h2 className="mt-2 text-lg font-semibold tracking-tight">
              {approval.name}
            </h2>
            <p className="mt-2 text-sm text-muted-foreground">
              {approval.message}
            </p>
            <div className="mt-4 max-h-60 overflow-y-auto rounded-xl border border-border/70 bg-background/70 px-3 py-2">
              <Json value={approval.input} />
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <Button
                variant="destructive"
                onClick={() => void handleApprovalDecision(false)}
              >
                Deny
              </Button>
              <Button onClick={() => void handleApprovalDecision(true)}>
                Approve
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}

// ---- Pure reducers over the conversation item list ----------------------

// Append streamed text to the current (non-finalized) assistant item for the
// run, or start a new one. Tool items between deltas split the assistant turn.
function appendDelta(
  items: ConversationItem[],
  runId: string,
  text: string
): ConversationItem[] {
  const last = items[items.length - 1];
  if (
    last &&
    last.kind === 'assistant' &&
    last.runId === runId &&
    !last.finalized
  ) {
    const updated: ConversationItem = { ...last, text: last.text + text };
    return [...items.slice(0, -1), updated];
  }
  return [...items, { kind: 'assistant', runId, text, finalized: false }];
}

// Finalize the streaming assistant item for the run with the canonical content,
// or add a finalized item if none was streaming (e.g. no deltas arrived).
function finalizeMessage(
  items: ConversationItem[],
  runId: string,
  content: string
): ConversationItem[] {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (item.kind === 'assistant' && item.runId === runId && !item.finalized) {
      const updated: ConversationItem = {
        ...item,
        text: content,
        finalized: true
      };
      return [...items.slice(0, i), updated, ...items.slice(i + 1)];
    }
  }
  return [...items, { kind: 'assistant', runId, text: content, finalized: true }];
}

// Attach a tool_result to its matching tool_call by toolUseId.
function attachResult(
  items: ConversationItem[],
  toolUseId: string,
  result: { content: string; isError: boolean }
): ConversationItem[] {
  return items.map((item) =>
    item.kind === 'tool' && item.toolUseId === toolUseId
      ? { ...item, result }
      : item
  );
}
