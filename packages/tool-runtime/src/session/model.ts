import type { JsonObject } from '../core/tool.js';
import type { ToolDescriptor } from '../core/descriptor.js';
import type { MessageContent } from './content.js';

// One entry in the conversation history. Tool calls/results are attached to the
// turn that produced them so a model client can reconstruct the exchange. The
// session reuses `RuntimeContext` for live tool state (todos/tasks/...) and keeps
// only this serializable transcript on the side.
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

// Input handed to the model client for a single turn. `tools` are Pillar 1
// descriptors; `signal` aborts the turn when the session is cancelled. `system`
// is the agent's system prompt (rendered by the caller, e.g. from
// `@colorful-code/prompts`) — an adapter sends it as the provider's system
// channel (Anthropic top-level `system`, OpenAI a leading `system` message).
export type ModelTurnInput = {
  history: ConversationEntry[];
  tools: ToolDescriptor[];
  signal: AbortSignal;
  system?: string;
};

// Streamed model output for a single completion. `text` accumulates into the
// assistant message; each `tool_use` is collected by the loop (the tools run
// after the completion ends, not inline); `usage` reports the provider's token
// accounting for the completion (best effort — adapters that cannot observe it
// simply never emit it); `end` closes the completion. The turn loop owns
// re-invocation: after running the collected tools it issues a fresh `run` for
// the next completion.
export type ModelTurnEvent =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; toolUseId: string; name: string; input: JsonObject }
  | { type: 'usage'; inputTokens?: number; outputTokens?: number }
  | { type: 'end' };

// The injected model boundary. One `run` call yields exactly one completion;
// real providers end a completion at the tool call (`stop_reason: tool_use` /
// `finish_reason: tool_calls`). Real provider wiring is a follow-up; the engine
// only depends on this async-iterable contract.
export interface ModelClient {
  run(input: ModelTurnInput): AsyncIterable<ModelTurnEvent>;
}

// A single scripted completion: the `ModelTurnEvent[]` one `run` call serves.
export type ScriptedRound = ModelTurnEvent[];

// A deterministic mock model used by tests, modelling the multi-round loop:
// each `run` call consumes the next scripted round (one completion). A round
// auto-terminates with an implicit `end` if one is not supplied. When the
// rounds run out, every further `run` serves an empty `end`-only completion
// (no text, no tool uses) so the loop terminates cleanly with `completed`.
//
// Example — a two-round script (request a tool, then a final text answer):
//   createScriptedModelClient([
//     [{ type: "text", text: "Listing." },
//      { type: "tool_use", toolUseId: "c1", name: "TaskList", input: {} }],
//     [{ type: "text", text: "Done." }],
//   ]);
export function createScriptedModelClient(
  rounds: ScriptedRound[],
): ModelClient {
  let index = 0;
  return {
    run(input: ModelTurnInput): AsyncIterable<ModelTurnEvent> {
      const round = index < rounds.length ? rounds[index]! : [];
      index += 1;
      return scriptedCompletion(round, input.signal);
    },
  };
}

async function* scriptedCompletion(
  events: ModelTurnEvent[],
  signal: AbortSignal,
): AsyncIterable<ModelTurnEvent> {
  let sawEnd = false;
  for (const event of events) {
    if (signal.aborted) {
      return;
    }
    if (event.type === 'end') {
      sawEnd = true;
    }
    yield event;
  }
  if (!sawEnd && !signal.aborted) {
    yield { type: 'end' };
  }
}
