// Wire types for the agent session API. These are deliberately kept local to the
// web app (rather than imported from `@colorful-code/tool-runtime`) so the debug
// client stays decoupled from server-only runtime internals. The raw event log
// renders arbitrary JSON, so we only need enough structure to drive the UI.

export type PermissionMode =
  | 'default'
  | 'plan'
  | 'acceptEdits'
  | 'readOnly'
  | 'bypass';

export const PERMISSION_MODES: readonly PermissionMode[] = [
  'default',
  'plan',
  'acceptEdits',
  'readOnly',
  'bypass'
];

export type ModelProtocol = 'anthropic' | 'openai';

// Model configuration sent in the create-session body. `apiKey` is a secret: it
// is only ever placed here for the single create request and never stored.
export type ModelConfig = {
  preset?: string;
  model?: string;
  baseURL?: string;
  protocol?: ModelProtocol;
  apiKey?: string;
};

export type RunStatus = 'running' | 'completed' | 'cancelled' | 'error';

export type JsonObject = Record<string, unknown>;

// The full SessionEvent union streamed over SSE. Each event's SSE `event:` name
// equals its `type`; `data` is the JSON-encoded event below.
export type SessionEvent =
  | { type: 'run_status'; status: RunStatus; runId: string }
  | { type: 'message_delta'; runId: string; text: string }
  | { type: 'message'; runId: string; role: 'assistant'; content: string }
  | {
      type: 'tool_call';
      runId: string;
      toolUseId: string;
      name: string;
      input: JsonObject;
    }
  | {
      type: 'tool_result';
      runId: string;
      toolUseId: string;
      content: string;
      isError?: boolean;
    }
  | {
      type: 'approval_required';
      runId: string;
      requestId: string;
      toolUseId: string;
      name: string;
      input: JsonObject;
      message: string;
      suggestions?: unknown[];
    }
  | { type: 'permission_decision'; runId: string; entry: unknown }
  | { type: 'todos_updated'; runId: string; todos: unknown[] }
  | {
      type: 'usage';
      runId: string;
      inputTokens?: number;
      outputTokens?: number;
    }
  | {
      type: 'context_compacted';
      runId: string;
      tokensBefore: number;
      tokensAfter: number;
      entriesSummarized: number;
    }
  | { type: 'error'; runId: string; message: string };

export type SessionEventType = SessionEvent['type'];

// Every event type, used to register one SSE listener per name (a plain
// `onmessage` never fires because the server names every event).
export const SESSION_EVENT_TYPES: readonly SessionEventType[] = [
  'run_status',
  'message_delta',
  'message',
  'tool_call',
  'tool_result',
  'approval_required',
  'permission_decision',
  'todos_updated',
  'usage',
  'context_compacted',
  'error'
];

export type ApprovalDecision =
  | { behavior: 'allow'; updatedInput?: JsonObject }
  | { behavior: 'deny'; message?: string };

export type ControlMessage =
  | { type: 'approval_response'; requestId: string; decision: ApprovalDecision }
  | { type: 'cancel' }
  | { type: 'set_permission_mode'; mode: PermissionMode };
