import type { JsonObject } from "../core/tool.js";
import type { PermissionMode } from "../core/permissions.js";

// Inbound control messages flow client -> server. Unlike a one-shot request
// these can arrive at any time, including mid-run (`approval_response`, `cancel`).
export type ControlMessage =
  // Append a user message and run a turn.
  | { type: "user_message"; text: string }
  // Resolve a parked `approval_required` event. `requestId` correlates it to the
  // emitted approval; the decision mirrors the runner's `ApprovalResponse`.
  | {
      type: "approval_response";
      requestId: string;
      decision:
        | { behavior: "allow"; updatedInput?: JsonObject }
        | { behavior: "deny"; message?: string };
    }
  // Abort the current run (and auto-deny any pending approvals).
  | { type: "cancel" }
  // Mutate the live permission mode for subsequent decisions.
  | { type: "set_permission_mode"; mode: PermissionMode };
