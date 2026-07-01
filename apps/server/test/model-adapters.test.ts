import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type {
  ModelTurnEvent,
  ModelTurnInput,
  ToolDescriptor,
} from '@colorful-code/tool-runtime';
import {
  AnthropicModelClient,
  type AnthropicStreamClient,
} from '../src/model/anthropic-client';
import {
  OpenAIModelClient,
  type OpenAIStreamClient,
} from '../src/model/openai-client';

// ---------------------------------------------------------------------------
// These tests drive each protocol adapter with a FAKE injected SDK client whose
// stream yields synthetic events — no network, no real keys. They assert the
// streaming -> ModelTurnEvent mapping (text deltas, multi-fragment tool-call
// argument accumulation, single terminal `end`) and the request translation
// (the object passed to the fake client's stream/create method).
// ---------------------------------------------------------------------------

const NEVER_ABORT = new AbortController().signal;

async function collect(
  events: AsyncIterable<ModelTurnEvent>,
): Promise<ModelTurnEvent[]> {
  const out: ModelTurnEvent[] = [];
  for await (const event of events) {
    out.push(event);
  }
  return out;
}

// A throwaway ToolDescriptor for the translation assertions. Only the model-facing
// fields matter to the adapters (name/description/inputSchema).
function fakeTool(): ToolDescriptor {
  return {
    name: 'Write',
    description: 'Write a file.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
    source: 'builtin',
    readOnly: false,
    destructive: true,
    concurrencySafe: false,
    enabled: true,
  };
}

// A history that exercises the assistant-with-toolCalls + tool-results path. The
// system prompt is supplied via `system` (not derived from history).
function translationHistory(): ModelTurnInput {
  return {
    history: [
      { role: 'user', content: 'Write hello to a.txt' },
      {
        role: 'assistant',
        content: 'Writing the file.',
        toolCalls: [
          { toolUseId: 'call-1', name: 'Write', input: { path: 'a.txt' } },
        ],
      },
      {
        role: 'tool',
        content: '',
        toolResults: [
          { toolUseId: 'call-1', content: 'wrote a.txt', isError: false },
        ],
      },
    ],
    tools: [fakeTool()],
    signal: NEVER_ABORT,
    system: 'You are a helpful agent.',
  };
}

// ----------------------------- Anthropic ----------------------------------

// Builds a fake Anthropic client whose `messages.stream` yields the given raw
// events and records the params it was called with.
function fakeAnthropicClient(events: unknown[]): {
  client: AnthropicStreamClient;
  calls: unknown[];
} {
  const calls: unknown[] = [];
  const client: AnthropicStreamClient = {
    messages: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      stream(params: any): any {
        calls.push(params);
        return (async function* () {
          for (const event of events) {
            yield event;
          }
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        })() as any;
      },
    },
  };
  return { client, calls };
}

test('anthropic adapter: text deltas, accumulated tool_use, single end', async () => {
  const { client } = fakeAnthropicClient([
    { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'Writing ' },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'the file.' },
    },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'content_block_start',
      index: 1,
      content_block: {
        type: 'tool_use',
        id: 'call-1',
        name: 'Write',
        input: {},
      },
    },
    {
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'input_json_delta', partial_json: '{"pa' },
    },
    {
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'input_json_delta', partial_json: 'th":"a.txt"}' },
    },
    { type: 'content_block_stop', index: 1 },
    { type: 'message_stop' },
  ]);

  const adapter = new AnthropicModelClient({ client, model: 'claude-test' });
  const events = await collect(
    adapter.run({ history: [], tools: [], signal: NEVER_ABORT }),
  );

  const texts = events
    .filter(
      (e): e is Extract<ModelTurnEvent, { type: 'text' }> => e.type === 'text',
    )
    .map((e) => e.text);
  assert.deepEqual(texts, ['Writing ', 'the file.']);

  const toolUses = events.filter(
    (e): e is Extract<ModelTurnEvent, { type: 'tool_use' }> =>
      e.type === 'tool_use',
  );
  assert.equal(toolUses.length, 1, 'exactly one tool_use');
  assert.equal(toolUses[0]?.toolUseId, 'call-1');
  assert.equal(toolUses[0]?.name, 'Write');
  assert.deepEqual(toolUses[0]?.input, { path: 'a.txt' });

  const ends = events.filter((e) => e.type === 'end');
  assert.equal(ends.length, 1, 'exactly one end');
  assert.equal(events.at(-1)?.type, 'end', 'end is last');
});

test('anthropic adapter: emits thinking deltas', async () => {
  const { client } = fakeAnthropicClient([
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'thinking' },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking: 'Considering options.' },
    },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_stop' },
  ]);

  const adapter = new AnthropicModelClient({ client, model: 'claude-test' });
  const events = await collect(
    adapter.run({ history: [], tools: [], signal: NEVER_ABORT }),
  );

  assert.deepEqual(events, [
    { type: 'thinking', text: 'Considering options.' },
    { type: 'end' },
  ]);
});

test('anthropic adapter: translates history + tools into the request', async () => {
  const { client, calls } = fakeAnthropicClient([{ type: 'message_stop' }]);
  const adapter = new AnthropicModelClient({
    client,
    model: 'claude-test',
    maxTokens: 1234,
  });
  await collect(adapter.run(translationHistory()));

  assert.equal(calls.length, 1);
  const params = calls[0] as Record<string, unknown>;
  assert.equal(params.model, 'claude-test');
  assert.equal(params.max_tokens, 1234);
  // The system prompt comes from `input.system`, set as top-level `system`.
  assert.equal(params.system, 'You are a helpful agent.');
  // Adaptive thinking is on by default.
  assert.deepEqual(params.thinking, { type: 'adaptive' });

  const messages = params.messages as Array<Record<string, unknown>>;
  // user(Write hello) -> assistant(text + tool_use) -> user(tool_result)
  assert.equal(messages.length, 3);
  assert.equal(messages[0]?.role, 'user');
  assert.equal(messages[0]?.content, 'Write hello to a.txt');

  assert.equal(messages[1]?.role, 'assistant');
  const assistantBlocks = messages[1]?.content as Array<
    Record<string, unknown>
  >;
  assert.deepEqual(assistantBlocks[0], {
    type: 'text',
    text: 'Writing the file.',
  });
  assert.deepEqual(assistantBlocks[1], {
    type: 'tool_use',
    id: 'call-1',
    name: 'Write',
    input: { path: 'a.txt' },
  });

  assert.equal(messages[2]?.role, 'user');
  const resultBlocks = messages[2]?.content as Array<Record<string, unknown>>;
  assert.deepEqual(resultBlocks[0], {
    type: 'tool_result',
    tool_use_id: 'call-1',
    content: 'wrote a.txt',
  });

  const tools = params.tools as Array<Record<string, unknown>>;
  assert.equal(tools.length, 1);
  assert.equal(tools[0]?.name, 'Write');
  assert.equal(tools[0]?.description, 'Write a file.');
  assert.deepEqual(tools[0]?.input_schema, {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
  });
});

test('anthropic adapter: translates user content blocks into multimodal message blocks', async () => {
  const { client, calls } = fakeAnthropicClient([{ type: 'message_stop' }]);
  const adapter = new AnthropicModelClient({ client, model: 'claude-test' });

  await collect(
    adapter.run({
      history: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Describe this image.' },
            { type: 'image', mediaType: 'image/png', data: 'aW1hZ2U=' },
          ],
        },
      ],
      tools: [],
      signal: NEVER_ABORT,
    }),
  );

  const params = calls[0] as Record<string, unknown>;
  const messages = params.messages as Array<Record<string, unknown>>;
  assert.deepEqual(messages[0], {
    role: 'user',
    content: [
      { type: 'text', text: 'Describe this image.' },
      {
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/png',
          data: 'aW1hZ2U=',
        },
      },
    ],
  });
});

test('anthropic adapter: retries a transient request failure before any output', async () => {
  let attempts = 0;
  const client: AnthropicStreamClient = {
    messages: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      stream(): any {
        attempts += 1;
        if (attempts === 1) {
          const error = new Error('rate limited') as Error & {
            status?: number;
          };
          error.status = 429;
          throw error;
        }
        return (async function* () {
          yield {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: 'recovered' },
          };
          yield { type: 'message_stop' };
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        })() as any;
      },
    },
  };

  const adapter = new AnthropicModelClient({ client, model: 'claude-test' });
  const events = await collect(
    adapter.run({ history: [], tools: [], signal: NEVER_ABORT }),
  );

  assert.equal(attempts, 2);
  assert.deepEqual(
    events.map((event) => event.type),
    ['text', 'end'],
  );
});

// ------------------------------ OpenAI ------------------------------------

// Builds a fake OpenAI client whose `chat.completions.create` resolves to an async
// iterable of the given chunks and records the body it was called with.
function fakeOpenAIClient(chunks: unknown[]): {
  client: OpenAIStreamClient;
  calls: unknown[];
} {
  const calls: unknown[] = [];
  const client: OpenAIStreamClient = {
    chat: {
      completions: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        create(body: any): any {
          calls.push(body);
          return Promise.resolve(
            (async function* () {
              for (const chunk of chunks) {
                yield chunk;
              }
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
            })() as any,
          );
        },
      },
    },
  };
  return { client, calls };
}

test('openai adapter: content deltas, accumulated tool_use, single end', async () => {
  const { client } = fakeOpenAIClient([
    {
      choices: [
        { index: 0, delta: { content: 'Writing ' }, finish_reason: null },
      ],
    },
    {
      choices: [
        { index: 0, delta: { content: 'the file.' }, finish_reason: null },
      ],
    },
    {
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: 'call-1',
                type: 'function',
                function: { name: 'Write', arguments: '{"pa' },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    },
    {
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [{ index: 0, function: { arguments: 'th":"a.txt"}' } }],
          },
          finish_reason: null,
        },
      ],
    },
    { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
  ]);

  const adapter = new OpenAIModelClient({ client, model: 'gpt-test' });
  const events = await collect(
    adapter.run({ history: [], tools: [], signal: NEVER_ABORT }),
  );

  const texts = events
    .filter(
      (e): e is Extract<ModelTurnEvent, { type: 'text' }> => e.type === 'text',
    )
    .map((e) => e.text);
  assert.deepEqual(texts, ['Writing ', 'the file.']);

  const toolUses = events.filter(
    (e): e is Extract<ModelTurnEvent, { type: 'tool_use' }> =>
      e.type === 'tool_use',
  );
  assert.equal(toolUses.length, 1, 'exactly one tool_use');
  assert.equal(toolUses[0]?.toolUseId, 'call-1');
  assert.equal(toolUses[0]?.name, 'Write');
  assert.deepEqual(toolUses[0]?.input, { path: 'a.txt' });

  const ends = events.filter((e) => e.type === 'end');
  assert.equal(ends.length, 1, 'exactly one end');
  assert.equal(events.at(-1)?.type, 'end', 'end is last');
});

test('openai adapter: translates history + tools into the request', async () => {
  const { client, calls } = fakeOpenAIClient([
    { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
  ]);
  const adapter = new OpenAIModelClient({
    client,
    model: 'gpt-test',
    maxTokens: 555,
  });
  await collect(adapter.run(translationHistory()));

  assert.equal(calls.length, 1);
  const body = calls[0] as Record<string, unknown>;
  assert.equal(body.model, 'gpt-test');
  assert.equal(body.stream, true);
  assert.equal(body.max_tokens, 555);

  const messages = body.messages as Array<Record<string, unknown>>;
  // system -> user -> assistant(content + tool_calls) -> tool
  assert.equal(messages.length, 4);
  assert.deepEqual(messages[0], {
    role: 'system',
    content: 'You are a helpful agent.',
  });
  assert.deepEqual(messages[1], {
    role: 'user',
    content: 'Write hello to a.txt',
  });

  assert.equal(messages[2]?.role, 'assistant');
  assert.equal(messages[2]?.content, 'Writing the file.');
  const toolCalls = messages[2]?.tool_calls as Array<Record<string, unknown>>;
  assert.equal(toolCalls.length, 1);
  assert.equal(toolCalls[0]?.id, 'call-1');
  assert.equal(toolCalls[0]?.type, 'function');
  assert.deepEqual(toolCalls[0]?.function, {
    name: 'Write',
    arguments: JSON.stringify({ path: 'a.txt' }),
  });

  assert.deepEqual(messages[3], {
    role: 'tool',
    tool_call_id: 'call-1',
    content: 'wrote a.txt',
  });

  const tools = body.tools as Array<Record<string, unknown>>;
  assert.equal(tools.length, 1);
  assert.equal(tools[0]?.type, 'function');
  const fn = tools[0]?.function as Record<string, unknown>;
  assert.equal(fn.name, 'Write');
  assert.equal(fn.description, 'Write a file.');
  assert.deepEqual(fn.parameters, {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
  });
});

test('openai adapter: translates user content blocks into multimodal message parts', async () => {
  const { client, calls } = fakeOpenAIClient([
    { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
  ]);
  const adapter = new OpenAIModelClient({ client, model: 'gpt-test' });

  await collect(
    adapter.run({
      history: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Describe this image.' },
            { type: 'image', mediaType: 'image/png', data: 'aW1hZ2U=' },
          ],
        },
      ],
      tools: [],
      signal: NEVER_ABORT,
    }),
  );

  const body = calls[0] as Record<string, unknown>;
  const messages = body.messages as Array<Record<string, unknown>>;
  assert.deepEqual(messages[0], {
    role: 'user',
    content: [
      { type: 'text', text: 'Describe this image.' },
      {
        type: 'image_url',
        image_url: { url: 'data:image/png;base64,aW1hZ2U=' },
      },
    ],
  });
});

test('openai adapter: retries a transient request failure before any output', async () => {
  let attempts = 0;
  const client: OpenAIStreamClient = {
    chat: {
      completions: {
        create(): Promise<AsyncIterable<unknown>> {
          attempts += 1;
          if (attempts === 1) {
            const error = new Error('provider unavailable') as Error & {
              status?: number;
            };
            error.status = 503;
            return Promise.reject(error);
          }
          return Promise.resolve(
            (async function* () {
              yield {
                choices: [
                  {
                    index: 0,
                    delta: { content: 'recovered' },
                    finish_reason: 'stop',
                  },
                ],
              };
            })(),
          );
        },
      },
    },
  };

  const adapter = new OpenAIModelClient({
    client: client as OpenAIStreamClient,
    model: 'gpt-test',
  });
  const events = await collect(
    adapter.run({ history: [], tools: [], signal: NEVER_ABORT }),
  );

  assert.equal(attempts, 2);
  assert.deepEqual(
    events.map((event) => event.type),
    ['text', 'end'],
  );
});
