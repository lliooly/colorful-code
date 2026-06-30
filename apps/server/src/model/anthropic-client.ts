import type Anthropic from '@anthropic-ai/sdk';
import type {
  ConversationEntry,
  JsonObject,
  ModelClient,
  ModelTurnEvent,
  ModelTurnInput,
  ToolDescriptor
} from '@colorful-code/tool-runtime';

// Provider request/stream types, taken from the SDK's `Anthropic` namespace so a
// single import covers them (they are not re-exported as flat module members).
type MessageParam = Anthropic.MessageParam;
type MessageStreamParams = Anthropic.MessageStreamParams;
type RawMessageStreamEvent = Anthropic.RawMessageStreamEvent;
type AnthropicTool = Anthropic.Tool;

// Anthropic Messages protocol adapter. One `run` call streams exactly one model
// completion: text deltas surface as `text` events, tool calls accumulate their
// streamed JSON arguments into a single `tool_use`, and the completion closes
// with one `end` regardless of stop_reason.

// The slice of the SDK client this adapter uses. Declared structurally so tests
// can inject a fake whose `messages.stream` yields synthetic events without any
// network. The real `Anthropic` instance satisfies this shape.
export interface AnthropicStreamClient {
  messages: {
    stream(
      params: MessageStreamParams,
      options?: { signal?: AbortSignal }
    ): AsyncIterable<RawMessageStreamEvent>;
  };
}

export type AnthropicModelClientDeps = {
  client: AnthropicStreamClient;
  model: string;
  maxTokens?: number;
  temperature?: number;
  // Adaptive thinking ('adaptive', the default) lets the model decide when and
  // how much to reason; 'disabled' omits the param (for older models / when
  // `temperature` is needed — the two are mutually exclusive on 4.6+ Claude).
  thinking?: 'adaptive' | 'disabled';
};

// Default completion budget. Anthropic requires `max_tokens`; this is a generous
// floor used when the config does not pin one.
const DEFAULT_MAX_TOKENS = 8192;

export class AnthropicModelClient implements ModelClient {
  private readonly client: AnthropicStreamClient;
  private readonly model: string;
  private readonly maxTokens: number;
  private readonly temperature: number | undefined;
  private readonly adaptiveThinking: boolean;

  constructor(deps: AnthropicModelClientDeps) {
    this.client = deps.client;
    this.model = deps.model;
    this.maxTokens = deps.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.temperature = deps.temperature;
    this.adaptiveThinking = deps.thinking !== 'disabled';
  }

  async *run(input: ModelTurnInput): AsyncIterable<ModelTurnEvent> {
    const messages = toAnthropicMessages(input.history);
    const params: MessageStreamParams = {
      model: this.model,
      max_tokens: this.maxTokens,
      messages,
      ...(input.system !== undefined && input.system.length > 0
        ? { system: input.system }
        : {}),
      // Adaptive thinking (on by default). With the default `display: 'omitted'`
      // the thinking blocks stream empty and are ignored below — only the answer
      // text surfaces. Requires a 4.6+ Claude model; those reject `temperature`,
      // so don't combine the two (disable thinking + use an older model instead).
      ...(this.adaptiveThinking ? { thinking: { type: 'adaptive' } } : {}),
      ...(this.temperature !== undefined ? { temperature: this.temperature } : {}),
      ...(input.tools.length > 0 ? { tools: toAnthropicTools(input.tools) } : {})
    };

    const stream = this.client.messages.stream(params, {
      signal: input.signal
    });

    // Per-content-block accumulators for in-flight tool_use blocks, keyed by the
    // streamed block index. Anthropic streams a tool call's input as a sequence
    // of `input_json_delta` fragments that must be concatenated then parsed once.
    const toolBlocks = new Map<
      number,
      { id: string; name: string; argsJson: string }
    >();

    // Token accounting accumulated across the stream: `input_tokens` arrives on
    // `message_start`, `output_tokens` grows on each `message_delta`. Emitted as
    // a single `usage` event at the end of the completion.
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;

    for await (const event of stream) {
      if (input.signal.aborted) {
        return;
      }

      switch (event.type) {
        case 'message_start': {
          inputTokens = event.message.usage.input_tokens;
          outputTokens = event.message.usage.output_tokens;
          break;
        }
        case 'message_delta': {
          outputTokens = event.usage.output_tokens;
          break;
        }
        case 'content_block_start': {
          if (event.content_block.type === 'tool_use') {
            toolBlocks.set(event.index, {
              id: event.content_block.id,
              name: event.content_block.name,
              argsJson: ''
            });
          }
          break;
        }
        case 'content_block_delta': {
          if (event.delta.type === 'text_delta') {
            yield { type: 'text', text: event.delta.text };
          } else if (event.delta.type === 'input_json_delta') {
            const block = toolBlocks.get(event.index);
            if (block) {
              block.argsJson += event.delta.partial_json;
            }
          }
          break;
        }
        case 'content_block_stop': {
          const block = toolBlocks.get(event.index);
          if (block) {
            toolBlocks.delete(event.index);
            yield {
              type: 'tool_use',
              toolUseId: block.id,
              name: block.name,
              input: parseToolInput(block.argsJson)
            };
          }
          break;
        }
        case 'message_stop': {
          // Any stop_reason terminates this completion.
          yield* emitUsage(inputTokens, outputTokens);
          yield { type: 'end' };
          return;
        }
        default:
          break;
      }
    }

    // The stream ended without an explicit message_stop (e.g. a short fake
    // stream in a test); still report usage (if any) and close exactly once.
    yield* emitUsage(inputTokens, outputTokens);
    yield { type: 'end' };
  }
}

// Yields a single `usage` event when the provider reported any token counts;
// nothing otherwise (so a stream with no usage data stays silent on usage).
function* emitUsage(
  inputTokens: number | undefined,
  outputTokens: number | undefined
): Generator<ModelTurnEvent> {
  if (inputTokens === undefined && outputTokens === undefined) {
    return;
  }
  yield {
    type: 'usage',
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {})
  };
}

// Empty / malformed argument JSON falls back to `{}` so a tool with no required
// inputs (Anthropic sometimes streams no input_json_delta) still dispatches.
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

// Maps the conversation history to Anthropic's message list. The system prompt
// is NOT derived from history — it is supplied separately via `input.system` and
// set as the request's top-level `system` field. Every `user` entry becomes a
// user message.
export function toAnthropicMessages(
  history: ConversationEntry[]
): MessageParam[] {
  const messages: MessageParam[] = [];

  for (const entry of history) {
    if (entry.role === 'assistant') {
      const blocks: MessageParam['content'] = [];
      if (entry.content.length > 0) {
        blocks.push({ type: 'text', text: entry.content });
      }
      for (const call of entry.toolCalls ?? []) {
        blocks.push({
          type: 'tool_use',
          id: call.toolUseId,
          name: call.name,
          input: call.input
        });
      }
      messages.push({ role: 'assistant', content: blocks });
      continue;
    }

    if (entry.role === 'tool') {
      messages.push({
        role: 'user',
        content: (entry.toolResults ?? []).map((result) => ({
          type: 'tool_result',
          tool_use_id: result.toolUseId,
          content: result.content,
          ...(result.isError ? { is_error: true } : {})
        }))
      });
      continue;
    }

    // role === 'user'.
    messages.push({ role: 'user', content: entry.content });
  }

  return messages;
}

// Maps Pillar 1 tool descriptors to Anthropic tool definitions. The descriptor's
// JSON Schema is passed through as `input_schema`.
export function toAnthropicTools(tools: ToolDescriptor[]): AnthropicTool[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema as Anthropic.Tool.InputSchema
  }));
}

// Re-exported only to keep the `Anthropic` type import meaningful for consumers
// that construct the real client; the adapter itself depends on the structural
// `AnthropicStreamClient` so it stays testable.
export type { Anthropic };
