import { describeTools } from "../core/descriptor.js";
import type { ToolRegistry } from "../core/registry.js";
import type { ToolRunner } from "../core/runner.js";
import type { RuntimeContext, TodoItem } from "../core/tool.js";
import type { PermissionAuditEntry } from "../core/permissions.js";
import type { SessionEvent } from "./events.js";
import type {
  ConversationEntry,
  ConversationToolCall,
  ConversationToolResult,
  ModelClient,
} from "./model.js";

// Everything the turn loop needs from the owning session. Keeping this narrow
// makes the loop unit-testable and the session free to evolve independently.
export type TurnDeps = {
  runId: string;
  model: ModelClient;
  registry: ToolRegistry;
  runner: ToolRunner;
  context: RuntimeContext;
  history: ConversationEntry[];
  signal: AbortSignal;
  emit: (event: SessionEvent) => void;
};

// Drains audit entries the runner appended since `from` and emits one
// `permission_decision` per entry. Returns the new high-water mark.
function flushAudit(deps: TurnDeps, from: number): number {
  const audit = deps.context.permissionAudit;
  if (!audit) {
    return from;
  }
  for (let i = from; i < audit.length; i += 1) {
    const entry = audit[i] as PermissionAuditEntry;
    deps.emit({ type: "permission_decision", runId: deps.runId, entry });
  }
  return audit.length;
}

// Emits `todos_updated` when the live todo list changed during a step. Compared
// by reference-free snapshot so a mutated-in-place array is still detected.
function flushTodos(deps: TurnDeps, previous: string): string {
  const todos: TodoItem[] = deps.context.todos ?? [];
  const serialized = JSON.stringify(todos);
  if (serialized !== previous) {
    deps.emit({ type: "todos_updated", runId: deps.runId, todos: [...todos] });
  }
  return serialized;
}

// Runs a single turn against the model: emit `running`, build descriptors, stream
// model events (text -> message_delta; tool_use -> tool_call -> run -> tool_result),
// feed tool results back into history, and loop until the model emits `end`.
// Abort -> `cancelled`; thrown errors -> `error` + `error` status.
export async function runTurn(deps: TurnDeps): Promise<void> {
  deps.emit({ type: "run_status", status: "running", runId: deps.runId });

  let auditCursor = deps.context.permissionAudit?.length ?? 0;
  let todosSnapshot = JSON.stringify(deps.context.todos ?? []);

  try {
    let assistantText = "";
    const toolCalls: ConversationToolCall[] = [];
    const toolResults: ConversationToolResult[] = [];

    const tools = describeTools(deps.registry.list());
    const stream = deps.model.run({
      history: deps.history,
      tools,
      signal: deps.signal,
    });

    for await (const event of stream) {
      if (deps.signal.aborted) {
        break;
      }

      if (event.type === "text") {
        assistantText += event.text;
        deps.emit({
          type: "message_delta",
          runId: deps.runId,
          text: event.text,
        });
        continue;
      }

      if (event.type === "tool_use") {
        const call: ConversationToolCall = {
          toolUseId: event.toolUseId,
          name: event.name,
          input: event.input,
        };
        toolCalls.push(call);
        deps.emit({
          type: "tool_call",
          runId: deps.runId,
          toolUseId: event.toolUseId,
          name: event.name,
          input: event.input,
        });

        // The runner drives the Pillar 2 permission flow, which may invoke
        // `context.requestApproval` (the session's parked-approval wiring) and
        // block here until the client answers or the run is cancelled.
        const result = await deps.runner.run({
          id: event.toolUseId,
          name: event.name,
          input: event.input,
        });

        auditCursor = flushAudit(deps, auditCursor);
        todosSnapshot = flushTodos(deps, todosSnapshot);

        const toolResult: ConversationToolResult = {
          toolUseId: result.toolUseId,
          content: result.content,
          ...(result.isError ? { isError: true } : {}),
        };
        toolResults.push(toolResult);
        deps.emit({
          type: "tool_result",
          runId: deps.runId,
          toolUseId: result.toolUseId,
          content: result.content,
          ...(result.isError ? { isError: true } : {}),
        });

        // Tool exchanges are appended as their own history entry so the model
        // can observe results on a subsequent turn.
        deps.history.push({
          role: "tool",
          content: result.content,
          toolCalls: [call],
          toolResults: [toolResult],
        });
        continue;
      }

      // event.type === "end": the model has nothing further to emit.
      break;
    }

    if (deps.signal.aborted) {
      deps.emit({ type: "run_status", status: "cancelled", runId: deps.runId });
      return;
    }

    if (assistantText.length > 0) {
      deps.history.push({
        role: "assistant",
        content: assistantText,
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
        ...(toolResults.length > 0 ? { toolResults } : {}),
      });
      deps.emit({
        type: "message",
        runId: deps.runId,
        role: "assistant",
        content: assistantText,
      });
    }

    auditCursor = flushAudit(deps, auditCursor);
    flushTodos(deps, todosSnapshot);

    deps.emit({ type: "run_status", status: "completed", runId: deps.runId });
  } catch (error) {
    if (deps.signal.aborted) {
      deps.emit({ type: "run_status", status: "cancelled", runId: deps.runId });
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    deps.emit({ type: "error", runId: deps.runId, message });
    deps.emit({ type: "run_status", status: "error", runId: deps.runId });
  }
}
