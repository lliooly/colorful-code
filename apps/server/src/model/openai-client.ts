import type OpenAI from 'openai';
import type {
  ChatCompletionChunk,
  ChatCompletionCreateParamsStreaming,
  ChatCompletionMessageParam,
  ChatCompletionTool
} from 'openai/resources/chat/completions';
import type {
  ConversationEntry,
  JsonObject,
  ModelClient,
  ModelTurnEvent,
  ModelTurnInput,
  ToolDescriptor
} from '@colorful-code/tool-runtime';

// OpenAI Chat Completions protocol adapter. Covers GPT, DeepSeek, and any
// OpenAI-compatible endpoint (selected via the config's baseURL). One `run` call
// streams exactly one completion: content deltas surface as `text`, tool-call
// argument fragments accumulate per `.index` into a single `tool_use`, and the
// completion closes with one `end`.

// The slice of the SDK client this adapter uses. Declared structurally so tests
// can inject a fake whose `chat.completions.create` returns a synthetic async
// iterable of chunks. The real `OpenAI` instance satisfies this shape.
export interface OpenAIStreamClient {
  chat: {
    completions: {
      create(
        body: ChatCompletionCreateParamsStreaming,
        options?: { signal?: AbortSignal }
      ): Promise<AsyncIterable<ChatCompletionChunk>>;
    };
  };
}

export type OpenAIModelClientDeps = {
  client: OpenAIStreamClient;
  model: string;
  maxTokens?: number;
  temperature?: number;
};

export class OpenAIModelClient implements ModelClient {
  private readonly client: OpenAIStreamClient;
  private readonly model: string;
  private readonly maxTokens: number | undefined;
  private readonly temperature: number | undefined;

  constructor(deps: OpenAIModelClientDeps) {
    this.client = deps.client;
    this.model = deps.model;
    this.maxTokens = deps.maxTokens;
    this.temperature = deps.temperature;
  }

  async *run(input: ModelTurnInput): AsyncIterable<ModelTurnEvent> {
    const body: ChatCompletionCreateParamsStreaming = {
      model: this.model,
      stream: true,
      messages: toOpenAIMessages(input.history, input.system),
      // Use `max_tokens` (not `max_completion_tokens`) for the broadest
      // compatibility: DeepSeek and most OpenAI-compatible endpoints accept it,
      // and the official OpenAI host still honours it (deprecated but valid).
      ...(this.maxTokens !== undefined ? { max_tokens: this.maxTokens } : {}),
      ...(this.temperature !== undefined ? { temperature: this.temperature } : {}),
      // Ask for a terminal usage chunk (OpenAI and DeepSeek both honour this).
      // Endpoints that ignore it simply never report usage; the adapter stays
      // silent on usage in that case rather than failing.
      stream_options: { include_usage: true },
      ...(input.tools.length > 0 ? { tools: toOpenAITools(input.tools) } : {})
    };

    const stream = await this.client.chat.completions.create(body, {
      signal: input.signal
    });

    // Per-index accumulators for in-flight tool calls. Fragments arrive keyed by
    // `.index`; `.id` and `.function.name` appear (usually on the first fragment)
    // and `.function.arguments` streams piecemeal across fragments.
    const toolCalls = new Map<
      number,
      { id: string; name: string; argsJson: string }
    >();

    // Token accounting. With `include_usage` the provider sends a terminal chunk
    // carrying `usage` (and usually empty `choices`); read it before the choice
    // guard so that final chunk is not skipped.
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;

    for await (const chunk of stream) {
      if (input.signal.aborted) {
        return;
      }

      if (chunk.usage) {
        inputTokens = chunk.usage.prompt_tokens;
        outputTokens = chunk.usage.completion_tokens;
      }

      const choice = chunk.choices[0];
      if (!choice) {
        continue;
      }

      const content = choice.delta.content;
      if (typeof content === 'string' && content.length > 0) {
        yield { type: 'text', text: content };
      }

      for (const fragment of choice.delta.tool_calls ?? []) {
        const slot = toolCalls.get(fragment.index) ?? {
          id: '',
          name: '',
          argsJson: ''
        };
        if (typeof fragment.id === 'string' && fragment.id.length > 0) {
          slot.id = fragment.id;
        }
        if (typeof fragment.function?.name === 'string') {
          slot.name = fragment.function.name;
        }
        if (typeof fragment.function?.arguments === 'string') {
          slot.argsJson += fragment.function.arguments;
        }
        toolCalls.set(fragment.index, slot);
      }

      // `tool_calls` finish reason marks every accumulated tool call complete.
      if (choice.finish_reason === 'tool_calls') {
        for (const event of flushToolCalls(toolCalls)) {
          yield event;
        }
      }
    }

    // Stream ended. Flush any tool calls not already emitted on a finish_reason
    // (some compatible endpoints omit the dedicated tool_calls chunk), report
    // usage if the provider sent it, then close.
    for (const event of flushToolCalls(toolCalls)) {
      yield event;
    }
    if (inputTokens !== undefined || outputTokens !== undefined) {
      yield {
        type: 'usage',
        ...(inputTokens !== undefined ? { inputTokens } : {}),
        ...(outputTokens !== undefined ? { outputTokens } : {})
      };
    }
    yield { type: 'end' };
  }
}

// Emits one `tool_use` per accumulated tool call and clears the map so a later
// flush at stream end does not double-emit.
function* flushToolCalls(
  toolCalls: Map<number, { id: string; name: string; argsJson: string }>
): Iterable<ModelTurnEvent> {
  for (const slot of toolCalls.values()) {
    yield {
      type: 'tool_use',
      toolUseId: slot.id,
      name: slot.name,
      input: parseToolInput(slot.argsJson)
    };
  }
  toolCalls.clear();
}

// Empty / malformed argument JSON falls back to `{}` so a no-argument tool call
// still dispatches.
function parseToolInput(json: string): JsonObject {
  const trimmed = json.trim();
  if (trimmed.length === 0) {
    return {};
  }
  const parsed: unknown = JSON.parse(trimmed);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Tool input did not parse to a JSON object.');
  }
  return parsed as JsonObject;
}

// Maps the conversation history to OpenAI's message list. The system prompt is
// supplied separately via `system` and prepended as a leading `system` message
// (not derived from history). An assistant entry with tool calls carries
// `tool_calls`; a `tool` entry expands to one `role:'tool'` message per result
// (each keyed by `tool_call_id`); every `user` entry becomes a user message.
export function toOpenAIMessages(
  history: ConversationEntry[],
  system?: string
): ChatCompletionMessageParam[] {
  const messages: ChatCompletionMessageParam[] = [];

  if (system !== undefined && system.length > 0) {
    messages.push({ role: 'system', content: system });
  }

  for (const entry of history) {
    if (entry.role === 'assistant') {
      const toolCalls = (entry.toolCalls ?? []).map((call) => ({
        id: call.toolUseId,
        type: 'function' as const,
        function: {
          name: call.name,
          arguments: JSON.stringify(call.input)
        }
      }));
      messages.push({
        role: 'assistant',
        content: entry.content,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {})
      });
      continue;
    }

    if (entry.role === 'tool') {
      for (const result of entry.toolResults ?? []) {
        messages.push({
          role: 'tool',
          tool_call_id: result.toolUseId,
          content: result.content
        });
      }
      continue;
    }

    // role === 'user'.
    messages.push({ role: 'user', content: entry.content });
  }

  return messages;
}

// Maps Pillar 1 tool descriptors to OpenAI function-tool definitions. The
// descriptor's JSON Schema is passed through as `parameters`.
export function toOpenAITools(tools: ToolDescriptor[]): ChatCompletionTool[] {
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema as Record<string, unknown>
    }
  }));
}

// Re-exported to keep the `OpenAI` type import meaningful for consumers that
// construct the real client; the adapter depends on the structural
// `OpenAIStreamClient` so it stays testable.
export type { OpenAI };
