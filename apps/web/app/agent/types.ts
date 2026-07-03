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
  'bypass',
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

export type TextContentBlock = {
  type: 'text';
  text: string;
};

export type ImageContentBlock = {
  type: 'image';
  mediaType: string;
  data: string;
};

export type ContentBlock = TextContentBlock | ImageContentBlock;

export type MessageContent = string | ContentBlock[];

export type ConversationToolCall = {
  toolUseId: string;
  name: string;
  input: JsonObject;
};

export type ConversationToolResult = {
  toolUseId: string;
  content: string;
  isError?: boolean;
};

export type ConversationEntry = {
  role: 'user' | 'assistant' | 'tool';
  content: MessageContent;
  toolCalls?: ConversationToolCall[];
  toolResults?: ConversationToolResult[];
};

export type SessionSnapshot = {
  id: string;
  cwd?: string;
  history: ConversationEntry[];
  permissionMode: PermissionMode;
  workspaceRoots: string[];
  todos: unknown[];
};

export type Checkpoint = {
  id: string;
  sessionId: string;
  parentCheckpointId?: string;
  createdAt: number;
  runId?: string;
  label?: string;
  summary?: string;
  snapshot: SessionSnapshot;
  fileChanges?: unknown;
};

export type ListCheckpointsResponse = {
  checkpoints: Checkpoint[];
  currentCheckpointId?: string;
};

export type CheckpointSessionResponse = {
  id: string;
  checkpointId: string;
};

export type SessionSummary = {
  id: string;
  title: string;
  updatedAt: number;
  cwd?: string;
  checkpointId?: string;
};

export type ListSessionsResponse = {
  sessions: SessionSummary[];
};

export type ToolInvocationSource =
  | { type: 'mcp'; server: string }
  | { type: 'builtin' }
  | { type: 'lsp' };

export type PatchLineKind = 'context' | 'added' | 'removed';

export type FilePatchLine = {
  kind: PatchLineKind;
  oldNumber?: number;
  newNumber?: number;
  text: string;
};

export type FilePatchHunk = {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: FilePatchLine[];
};

export type FilePatch = {
  path: string;
  status: 'added' | 'modified' | 'deleted';
  hunks: FilePatchHunk[];
  added: number;
  removed: number;
  conflictReason?: string;
};

export type EditProposalStatus =
  | 'proposed'
  | 'approved'
  | 'applied'
  | 'rejected'
  | 'conflict';

export type McpServerStatus = {
  name: string;
  status: 'connected' | 'failed';
  transport: 'stdio' | 'http' | 'sse';
  tools: Array<{
    name: string;
    registeredName?: string;
    description?: string;
  }>;
  resources: Array<{
    uri: string;
    name?: string;
    mimeType?: string;
    description?: string;
  }>;
  instructions?: string;
  error?: string;
};

export type LspServerStatus = {
  name: string;
  language: string;
  fileExtensions: string[];
  status: 'connected' | 'failed';
  error?: string;
};

export type HookFailurePolicy = 'fail-open' | 'fail-closed';

export type HookAuditEntry = {
  hookId: string;
  event: string;
  action: string;
  at: number;
  message?: string;
  durationMs?: number;
  error?: string;
};

// The full SessionEvent union streamed over SSE. Each event's SSE `event:` name
// equals its `type`; `data` is the JSON-encoded event below.
export type SessionEvent =
  | { type: 'mcp_status'; servers: McpServerStatus[] }
  | { type: 'lsp_status'; servers: LspServerStatus[] }
  | {
      type: 'voice_transcript_status';
      runId: string;
      requestId: string;
      status: 'connecting' | 'recording' | 'stopped';
    }
  | {
      type: 'voice_transcript_delta';
      runId: string;
      requestId: string;
      text: string;
    }
  | {
      type: 'voice_transcript_done';
      runId: string;
      requestId: string;
      text: string;
    }
  | {
      type: 'voice_transcript_error';
      runId: string;
      requestId: string;
      message: string;
    }
  | { type: 'hook_event'; runId: string; entry: HookAuditEntry }
  | {
      type: 'hook_failure';
      runId: string;
      hookId: string;
      hookEvent: string;
      message: string;
      policy: HookFailurePolicy;
    }
  | {
      type: 'file_created' | 'file_changed' | 'file_deleted';
      runId: string;
      path: string;
      at: number;
    }
  | { type: 'run_status'; status: RunStatus; runId: string }
  | { type: 'message_delta'; runId: string; text: string }
  | { type: 'thinking_delta'; runId: string; text: string }
  | { type: 'message'; runId: string; role: 'assistant'; content: string }
  | {
      type: 'tool_call';
      runId: string;
      toolUseId: string;
      name: string;
      input: JsonObject;
      source?: ToolInvocationSource;
    }
  | {
      type: 'tool_result';
      runId: string;
      toolUseId: string;
      content: string;
      isError?: boolean;
      source?: ToolInvocationSource;
    }
  | {
      type: 'approval_required';
      runId: string;
      requestId: string;
      toolUseId: string;
      name: string;
      input: JsonObject;
      message: string;
      source?: ToolInvocationSource;
      suggestions?: unknown[];
    }
  | {
      type: 'edit_proposed';
      runId: string;
      proposalId: string;
      toolUseId?: string;
      patches: FilePatch[];
    }
  | {
      type: 'edit_approved';
      runId: string;
      proposalId: string;
      toolUseId?: string;
      patches: FilePatch[];
    }
  | {
      type: 'edit_applied';
      runId: string;
      proposalId: string;
      toolUseId?: string;
      patches: FilePatch[];
    }
  | {
      type: 'edit_rejected';
      runId: string;
      proposalId: string;
      toolUseId?: string;
      patches: FilePatch[];
      reason?: string;
    }
  | {
      type: 'edit_conflict';
      runId: string;
      proposalId: string;
      toolUseId?: string;
      patches: FilePatch[];
      reason?: string;
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
  'mcp_status',
  'lsp_status',
  'voice_transcript_status',
  'voice_transcript_delta',
  'voice_transcript_done',
  'voice_transcript_error',
  'hook_event',
  'hook_failure',
  'file_created',
  'file_changed',
  'file_deleted',
  'run_status',
  'message_delta',
  'thinking_delta',
  'message',
  'tool_call',
  'tool_result',
  'approval_required',
  'edit_proposed',
  'edit_approved',
  'edit_applied',
  'edit_rejected',
  'edit_conflict',
  'permission_decision',
  'todos_updated',
  'usage',
  'context_compacted',
  'error',
];

export type ApprovalDecision =
  | { behavior: 'allow'; updatedInput?: JsonObject }
  | { behavior: 'deny'; message?: string };

export type ControlMessage =
  | { type: 'approval_response'; requestId: string; decision: ApprovalDecision }
  | {
      type: 'edit_decision';
      proposalId: string;
      decision: 'approve' | 'reject';
    }
  | { type: 'cancel' }
  | { type: 'set_permission_mode'; mode: PermissionMode }
  | { type: 'compact' };
