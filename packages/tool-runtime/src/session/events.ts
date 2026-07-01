import type {
  FilePatch,
  JsonObject,
  TodoItem,
  ToolInvocationSource,
} from '../core/tool.js';
import type {
  PermissionAuditEntry,
  PermissionRuleUpdate,
} from '../core/permissions.js';

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

// Output events flow server -> client over the session's event stream. Every
// event carries the `runId` of the turn that produced it so a client can route
// deltas to the right in-flight run. `approval_required` is the one event that
// awaits a correlated control response (`approval_response`) keyed by `requestId`.
export type SessionEvent =
  | { type: 'mcp_status'; servers: McpServerStatus[] }
  | {
      type: 'run_status';
      status: 'running' | 'completed' | 'cancelled' | 'error';
      runId: string;
    }
  // Streaming assistant text; concatenating `message_delta` over a run yields the
  // finalized `message` content.
  | { type: 'message_delta'; runId: string; text: string }
  // Finalized assistant message for the run.
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
  // Correlated approval prompt. The run parks until the client replies with an
  // `approval_response` carrying the same `requestId`.
  | {
      type: 'approval_required';
      runId: string;
      requestId: string;
      toolUseId: string;
      name: string;
      input: JsonObject;
      message: string;
      source?: ToolInvocationSource;
      suggestions?: PermissionRuleUpdate[];
    }
  | {
      type: 'edit_proposed';
      runId: string;
      proposalId: string;
      toolUseId: string;
      patches: FilePatch[];
    }
  | {
      type: 'edit_approved';
      runId: string;
      proposalId: string;
      toolUseId: string;
      patches: FilePatch[];
    }
  | {
      type: 'edit_applied';
      runId: string;
      proposalId: string;
      toolUseId: string;
      patches: FilePatch[];
    }
  | {
      type: 'edit_rejected';
      runId: string;
      proposalId: string;
      toolUseId: string;
      patches: FilePatch[];
      reason?: string;
    }
  | {
      type: 'edit_conflict';
      runId: string;
      proposalId: string;
      toolUseId: string;
      patches: FilePatch[];
      reason: string;
    }
  // Carries the audit entry the runner recorded for a permission decision.
  | { type: 'permission_decision'; runId: string; entry: PermissionAuditEntry }
  | { type: 'todos_updated'; runId: string; todos: TodoItem[] }
  // Provider token accounting for the completion just observed. Emitted only
  // when the model adapter reports usage; absent fields mean "not reported".
  | {
      type: 'usage';
      runId: string;
      inputTokens?: number;
      outputTokens?: number;
    }
  // History was summarized to stay within the context window. `tokensBefore` /
  // `tokensAfter` are the loop's pre/post estimates; `entriesSummarized` is how
  // many leading history entries the summary replaced.
  | {
      type: 'context_compacted';
      runId: string;
      tokensBefore: number;
      tokensAfter: number;
      entriesSummarized: number;
    }
  | { type: 'error'; runId: string; message: string };

export type SessionEventListener = (event: SessionEvent) => void;
