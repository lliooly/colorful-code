import type { JsonObject, TodoItem } from "../core/tool.js";
import type {
  PermissionAuditEntry,
  PermissionRuleUpdate,
} from "../core/permissions.js";

// Output events flow server -> client over the session's event stream. Every
// event carries the `runId` of the turn that produced it so a client can route
// deltas to the right in-flight run. `approval_required` is the one event that
// awaits a correlated control response (`approval_response`) keyed by `requestId`.
export type SessionEvent =
  | {
      type: "run_status";
      status: "running" | "completed" | "cancelled" | "error";
      runId: string;
    }
  // Streaming assistant text; concatenating `message_delta` over a run yields the
  // finalized `message` content.
  | { type: "message_delta"; runId: string; text: string }
  // Finalized assistant message for the run.
  | { type: "message"; runId: string; role: "assistant"; content: string }
  | {
      type: "tool_call";
      runId: string;
      toolUseId: string;
      name: string;
      input: JsonObject;
    }
  | {
      type: "tool_result";
      runId: string;
      toolUseId: string;
      content: string;
      isError?: boolean;
    }
  // Correlated approval prompt. The run parks until the client replies with an
  // `approval_response` carrying the same `requestId`.
  | {
      type: "approval_required";
      runId: string;
      requestId: string;
      toolUseId: string;
      name: string;
      input: JsonObject;
      message: string;
      suggestions?: PermissionRuleUpdate[];
    }
  // Carries the audit entry the runner recorded for a permission decision.
  | { type: "permission_decision"; runId: string; entry: PermissionAuditEntry }
  | { type: "todos_updated"; runId: string; todos: TodoItem[] }
  | { type: "error"; runId: string; message: string };

export type SessionEventListener = (event: SessionEvent) => void;
