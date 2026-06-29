import type { JsonObject } from "../core/tool.js";
import type { ToolDescriptor } from "../core/descriptor.js";

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
  role: "user" | "assistant" | "tool";
  content: string;
  toolCalls?: ConversationToolCall[];
  toolResults?: ConversationToolResult[];
};

// Input handed to the model client for a single turn. `tools` are Pillar 1
// descriptors; `signal` aborts the turn when the session is cancelled.
export type ModelTurnInput = {
  history: ConversationEntry[];
  tools: ToolDescriptor[];
  signal: AbortSignal;
};

// Streamed model output for a turn. `text` accumulates into the assistant
// message; each `tool_use` is dispatched through the runner; `end` closes the
// turn.
export type ModelTurnEvent =
  | { type: "text"; text: string }
  | { type: "tool_use"; toolUseId: string; name: string; input: JsonObject }
  | { type: "end" };

// The injected model boundary. Real provider wiring is a follow-up; the engine
// only depends on this async-iterable contract.
export interface ModelClient {
  run(input: ModelTurnInput): AsyncIterable<ModelTurnEvent>;
}

// A deterministic mock model used by tests. The script is replayed in order on
// every `run`. When `loop` is true (the default) a fresh copy of the script is
// served per turn, so a multi-turn conversation (e.g. after a tool result feeds
// back in) keeps producing output instead of stalling. Each script always
// terminates with an implicit `end` if one is not supplied.
export type ScriptedModelOptions = {
  loop?: boolean;
};

export function createScriptedModelClient(
  script: ModelTurnEvent[],
  options: ScriptedModelOptions = {},
): ModelClient {
  const loop = options.loop ?? true;
  let consumed = false;
  return {
    run(input: ModelTurnInput): AsyncIterable<ModelTurnEvent> {
      const events = loop || !consumed ? [...script] : [];
      consumed = true;
      return scriptedTurn(events, input.signal);
    },
  };
}

async function* scriptedTurn(
  events: ModelTurnEvent[],
  signal: AbortSignal,
): AsyncIterable<ModelTurnEvent> {
  let sawEnd = false;
  for (const event of events) {
    if (signal.aborted) {
      return;
    }
    if (event.type === "end") {
      sawEnd = true;
    }
    yield event;
  }
  if (!sawEnd && !signal.aborted) {
    yield { type: "end" };
  }
}
