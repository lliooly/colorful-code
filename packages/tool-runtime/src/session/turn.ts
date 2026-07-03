import { describeTools } from '../core/descriptor.js';
import type { ToolRegistry } from '../core/registry.js';
import type { ToolUseRequest } from '../core/runner.js';
import type { ToolScheduler } from '../core/scheduler.js';
import {
  toolInvocationSource,
  type JsonObject,
  type RuntimeContext,
  type TodoItem,
  type Tool,
  type ToolInvocationSource,
} from '../core/tool.js';
import type { PermissionAuditEntry } from '../core/permissions.js';
import {
  compactHistory,
  estimatePromptTokens,
  shouldCompact,
  type CompactionConfig,
} from './compaction.js';
import { runHooks } from '../core/hooks.js';
import type { SessionEvent } from './events.js';
import type {
  ConversationEntry,
  ConversationToolCall,
  ConversationToolResult,
  ModelClient,
} from './model.js';

// Everything the turn loop needs from the owning session. Keeping this narrow
// makes the loop unit-testable and the session free to evolve independently.
export type TurnDeps = {
  runId: string;
  model: ModelClient;
  registry: ToolRegistry;
  scheduler: ToolScheduler;
  context: RuntimeContext;
  history: ConversationEntry[];
  signal: AbortSignal;
  emit: (event: SessionEvent) => void;
  // The agent's system prompt, passed through to the model on every completion.
  systemPrompt?: string;
  // Automatic context-compaction policy. When present, the loop estimates the
  // prompt size before each completion and summarizes older history once it
  // crosses the configured threshold. Absent => no compaction (history grows
  // unbounded, as before).
  compaction?: CompactionConfig;
};

// Defensive ceiling on model round-trips per turn. Real providers should
// converge (a completion with no tool use ends the turn); a model that requests
// tools forever would otherwise loop without bound. Hitting this is treated as
// an error, surfaced like any other turn failure.
const MAX_ROUNDS = 64;

// Drains audit entries the runner appended since `from` and emits one
// `permission_decision` per entry. Returns the new high-water mark.
function flushAudit(deps: TurnDeps, from: number): number {
  const audit = deps.context.permissionAudit;
  if (!audit) {
    return from;
  }
  for (let i = from; i < audit.length; i += 1) {
    const entry = audit[i] as PermissionAuditEntry;
    deps.emit({ type: 'permission_decision', runId: deps.runId, entry });
  }
  return audit.length;
}

// Emits `todos_updated` when the live todo list changed during a step. Compared
// by reference-free snapshot so a mutated-in-place array is still detected.
function flushTodos(deps: TurnDeps, previous: string): string {
  const todos: TodoItem[] = deps.context.todos ?? [];
  const serialized = JSON.stringify(todos);
  if (serialized !== previous) {
    deps.emit({ type: 'todos_updated', runId: deps.runId, todos: [...todos] });
  }
  return serialized;
}

// Runs a turn against the model as a multi-round loop, the way real providers
// work: a completion ends at its tool calls (`stop_reason: tool_use`), so the
// loop runs the requested tools, appends their results to history, and issues a
// fresh request. Each `model.run` is one completion.
//
// Per round: emit `message_delta` for streamed text and collect `tool_use`
// events (WITHOUT running them) until `end`. Then push the assistant entry
// (text + collected tool calls) FIRST, emit `message` if there was text, and
// stop when no tools were requested (`completed`). Otherwise run each tool
// (`tool_call` -> runner -> flush audit/todos -> `tool_result`), append ONE
// `{ role: 'tool', toolResults }` entry (results come AFTER the assistant turn),
// and loop so the next completion sees the results.
//
// Abort (checked at the top of, and after, each completion stream) -> `cancelled`;
// other thrown errors -> `error` + `error` status. A `MAX_ROUNDS` ceiling guards
// against a model that requests tools without ever converging.
export async function runTurn(deps: TurnDeps): Promise<void> {
  deps.emit({ type: 'run_status', status: 'running', runId: deps.runId });

  let auditCursor = deps.context.permissionAudit?.length ?? 0;
  let todosSnapshot = JSON.stringify(deps.context.todos ?? []);

  try {
    for (let round = 0; ; round += 1) {
      if (round >= MAX_ROUNDS) {
        throw new Error(
          'Turn exceeded the maximum of ' +
            String(MAX_ROUNDS) +
            ' model rounds without completing.',
        );
      }

      let assistantText = '';
      const pendingToolUses: ConversationToolCall[] = [];

      const tools = describeTools(deps.registry.list());

      // Before issuing the completion, keep the prompt within the context
      // window: if the estimate crosses the threshold, summarize older history
      // in place. Compaction itself runs a model completion (which respects the
      // signal), so an abort during it surfaces below at the post-stream check.
      if (deps.compaction) {
        const promptTokens = estimatePromptTokens({
          history: deps.history,
          ...(deps.systemPrompt !== undefined
            ? { system: deps.systemPrompt }
            : {}),
          tools,
          ...(deps.compaction.estimateTokens
            ? { estimate: deps.compaction.estimateTokens }
            : {}),
        });
        if (shouldCompact(promptTokens, deps.compaction)) {
          const result = await compactHistory({
            history: deps.history,
            model: deps.model,
            config: deps.compaction,
            ...(deps.systemPrompt !== undefined
              ? { system: deps.systemPrompt }
              : {}),
            tools,
            signal: deps.signal,
          });
          if (result) {
            deps.emit({
              type: 'context_compacted',
              runId: deps.runId,
              tokensBefore: result.tokensBefore,
              tokensAfter: result.tokensAfter,
              entriesSummarized: result.entriesSummarized,
            });
          }
        }
      }

      const beforeModel = await runHooks(deps.context, {
        event: 'beforeModelRun',
        runId: deps.runId,
      });
      if (beforeModel.action === 'deny') {
        throw new Error(
          beforeModel.message ?? 'beforeModelRun hook denied the model run.',
        );
      }
      const appendedContext = beforeModel.appendedContext.join('\n\n');
      const system =
        appendedContext.length > 0
          ? [deps.systemPrompt, appendedContext].filter(Boolean).join('\n\n')
          : deps.systemPrompt;

      const stream = deps.model.run({
        history: deps.history,
        tools,
        signal: deps.signal,
        ...(system !== undefined ? { system } : {}),
      });

      // Consume exactly one completion: accumulate text and collect tool uses;
      // `end` closes the completion. Tools are NOT run inline — they run after
      // the stream ends so the assistant entry lands in history first.
      for await (const event of stream) {
        if (deps.signal.aborted) {
          break;
        }

        if (event.type === 'thinking') {
          deps.emit({
            type: 'thinking_delta',
            runId: deps.runId,
            text: event.text,
          });
          continue;
        }

        if (event.type === 'text') {
          assistantText += event.text;
          deps.emit({
            type: 'message_delta',
            runId: deps.runId,
            text: event.text,
          });
          continue;
        }

        if (event.type === 'tool_use') {
          pendingToolUses.push({
            toolUseId: event.toolUseId,
            name: event.name,
            input: event.input,
          });
          continue;
        }

        if (event.type === 'usage') {
          deps.emit({
            type: 'usage',
            runId: deps.runId,
            ...(event.inputTokens !== undefined
              ? { inputTokens: event.inputTokens }
              : {}),
            ...(event.outputTokens !== undefined
              ? { outputTokens: event.outputTokens }
              : {}),
          });
          continue;
        }

        // event.type === "end": this completion is done.
        break;
      }

      if (deps.signal.aborted) {
        deps.emit({
          type: 'run_status',
          status: 'cancelled',
          runId: deps.runId,
        });
        return;
      }
      await runHooks(deps.context, {
        event: 'afterModelRun',
        runId: deps.runId,
      });

      // History ordering: the assistant turn (text + its tool calls) is appended
      // BEFORE any tool results so the transcript reads assistant-then-tool.
      if (assistantText.length > 0 || pendingToolUses.length > 0) {
        deps.history.push({
          role: 'assistant',
          content: assistantText,
          ...(pendingToolUses.length > 0 ? { toolCalls: pendingToolUses } : {}),
        });
      }
      if (assistantText.length > 0) {
        deps.emit({
          type: 'message',
          runId: deps.runId,
          role: 'assistant',
          content: assistantText,
        });
      }

      // A completion with no tool requests is the model's final answer.
      if (pendingToolUses.length === 0) {
        auditCursor = flushAudit(deps, auditCursor);
        flushTodos(deps, todosSnapshot);
        deps.emit({
          type: 'run_status',
          status: 'completed',
          runId: deps.runId,
        });
        return;
      }

      // Run the requested tools. The runner drives the Pillar 2 permission flow,
      // which may invoke `context.requestApproval` (the session's parked-approval
      // wiring) and block until the client answers or the run is cancelled.
      const scheduledToolUses: ToolUseRequest[] = pendingToolUses.map(
        (call) => ({
          id: call.toolUseId,
          name: call.name,
          input: call.input,
        }),
      );
      const callsById = new Map(
        pendingToolUses.map((call) => [call.toolUseId, call]),
      );
      const sourcesById = new Map<string, ToolInvocationSource>();
      const runnerResults = await deps.scheduler.runAll(scheduledToolUses, {
        onToolStart(toolUse) {
          const call = callsById.get(toolUse.id);
          const tool = deps.registry.get(toolUse.name);
          const source = tool
            ? toolInvocationSource(
                tool as Tool,
                (call?.input ?? {}) as JsonObject,
              )
            : undefined;
          if (source) {
            sourcesById.set(toolUse.id, source);
          }
          deps.emit({
            type: 'tool_call',
            runId: deps.runId,
            toolUseId: toolUse.id,
            name: toolUse.name,
            input: call?.input ?? {},
            ...(source ? { source } : {}),
          });
        },
        onToolResult(result) {
          auditCursor = flushAudit(deps, auditCursor);
          todosSnapshot = flushTodos(deps, todosSnapshot);
          const source = sourcesById.get(result.toolUseId);
          deps.emit({
            type: 'tool_result',
            runId: deps.runId,
            toolUseId: result.toolUseId,
            content: result.content,
            ...(result.isError ? { isError: true } : {}),
            ...(source ? { source } : {}),
            ...(result.metadata ? { metadata: result.metadata } : {}),
          });
        },
      });

      const toolResults: ConversationToolResult[] = [];
      for (const result of runnerResults) {
        const call = callsById.get(result.toolUseId);
        const toolUseId = call?.toolUseId ?? result.toolUseId;
        const toolResult: ConversationToolResult = {
          toolUseId,
          content: result.content,
          ...(result.isError ? { isError: true } : {}),
        };
        toolResults.push(toolResult);
      }

      // Results land as a single `tool` entry AFTER the assistant turn, so the
      // next `model.run` observes the complete exchange.
      deps.history.push({
        role: 'tool',
        content: '',
        toolResults,
      });

      // Loop: re-invoke the model with the appended results.
    }
  } catch (error) {
    if (deps.signal.aborted) {
      deps.emit({ type: 'run_status', status: 'cancelled', runId: deps.runId });
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    deps.emit({ type: 'error', runId: deps.runId, message });
    deps.emit({ type: 'run_status', status: 'error', runId: deps.runId });
  }
}
