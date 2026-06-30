import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Session,
  estimatePromptTokens,
  selectCompactionBoundary,
  shouldCompact,
  type CompactionConfig,
  type ConversationEntry,
  type ModelClient,
  type SessionEvent,
} from '../index.js';

// A char-count estimator makes the token math exact and readable in tests.
const byChars = (text: string): number => text.length;

// ----------------------------- pure helpers -------------------------------

test('estimatePromptTokens counts history and the system prompt', () => {
  const history: ConversationEntry[] = [{ role: 'user', content: 'abcd' }];
  assert.equal(
    estimatePromptTokens({ history, system: 'xy', estimate: byChars }),
    6, // 4 (history) + 2 (system)
  );
});

test('estimatePromptTokens folds tool calls and results into the estimate', () => {
  const history: ConversationEntry[] = [
    {
      role: 'assistant',
      content: 'go',
      toolCalls: [{ toolUseId: 't1', name: 'Read', input: { path: 'a' } }],
    },
    { role: 'tool', content: '', toolResults: [{ toolUseId: 't1', content: 'data' }] },
  ];
  // Larger than just the visible `content` because the call name + serialized
  // input and the result content also travel to the provider.
  assert.ok(estimatePromptTokens({ history, estimate: byChars }) > 'go'.length);
});

test('shouldCompact triggers at the threshold fraction of the window', () => {
  const config: CompactionConfig = {
    contextWindow: 100,
    threshold: 0.5,
    keepRecentTokens: 40,
    prompt: 'x',
  };
  assert.equal(shouldCompact(49, config), false);
  assert.equal(shouldCompact(50, config), true);
  assert.equal(shouldCompact(80, config), true);
});

test('selectCompactionBoundary keeps the recent tail at a user boundary', () => {
  const history: ConversationEntry[] = [
    { role: 'user', content: 'aaaa' }, // 4
    { role: 'assistant', content: 'bb' }, // 2
    { role: 'user', content: 'cc' }, // 2
    { role: 'assistant', content: 'd' }, // 1
  ];
  // keepRecentTokens=4 fits the last user turn (cc + d = 3) but not the first.
  assert.equal(selectCompactionBoundary(history, 4, byChars), 2);
});

test('selectCompactionBoundary returns 0 when everything fits (nothing to summarize)', () => {
  const history: ConversationEntry[] = [
    { role: 'user', content: 'aa' },
    { role: 'assistant', content: 'b' },
  ];
  assert.equal(selectCompactionBoundary(history, 1000, byChars), 0);
});

// --------------------------- session integration --------------------------

const COMPACT_PROMPT = 'Summarize the conversation.';

// A model that answers "ok" to ordinary turns and "SUMMARY" to compaction
// requests (distinguished by the compaction prompt arriving on the system
// channel). Both end the completion after one text block.
function summarizingModel(): ModelClient {
  return {
    run(input) {
      const isSummary = input.system === COMPACT_PROMPT;
      return (async function* () {
        yield { type: 'text', text: isSummary ? 'SUMMARY' : 'ok' };
        yield { type: 'end' };
      })();
    },
  };
}

test('a session auto-compacts older history once the estimate crosses the threshold', async () => {
  const compaction: CompactionConfig = {
    contextWindow: 100,
    threshold: 0.5,
    keepRecentTokens: 40,
    prompt: COMPACT_PROMPT,
    estimateTokens: byChars,
  };
  const session = new Session({
    model: summarizingModel(),
    tools: [],
    compaction,
  });

  const events: SessionEvent[] = [];
  session.subscribe((event) => events.push(event));

  // Turn 1: a big message. There is no earlier user boundary yet, so even though
  // the estimate is over threshold, nothing is compacted.
  await session.submit('A'.repeat(5000));
  // Turn 2: a short message. Now turn 1 can be summarized away.
  await session.submit('second');

  const compactions = events.filter(
    (event) => event.type === 'context_compacted',
  );
  assert.equal(compactions.length, 1, 'exactly one compaction (turn 2 only)');
  const event = compactions[0] as Extract<
    SessionEvent,
    { type: 'context_compacted' }
  >;
  assert.equal(event.entriesSummarized, 2, 'user1 + assistant1 were summarized');
  assert.ok(
    event.tokensAfter < event.tokensBefore,
    'compaction shrank the prompt estimate',
  );

  // History is now [ merged-user(summary + recent request), assistant ].
  const history = session.snapshot().history;
  assert.equal(history.length, 2);
  assert.equal(history[0]?.role, 'user');
  assert.match(history[0]?.content ?? '', /SUMMARY/);
  assert.match(history[0]?.content ?? '', /second/, 'recent request preserved');
  assert.equal(history[1]?.role, 'assistant');
  assert.equal(history[1]?.content, 'ok');
});

test('a session does not compact while under the threshold', async () => {
  const compaction: CompactionConfig = {
    contextWindow: 1_000_000,
    threshold: 0.9,
    keepRecentTokens: 100,
    prompt: COMPACT_PROMPT,
    estimateTokens: byChars,
  };
  const session = new Session({
    model: summarizingModel(),
    tools: [],
    compaction,
  });

  const events: SessionEvent[] = [];
  session.subscribe((event) => events.push(event));

  await session.submit('hello');
  await session.submit('again');

  assert.ok(!events.some((event) => event.type === 'context_compacted'));
  // All four entries (two user + two assistant) are retained verbatim.
  assert.equal(session.snapshot().history.length, 4);
});

test('a usage event from the model surfaces on the session stream without ending the turn early', async () => {
  const model: ModelClient = {
    run() {
      return (async function* () {
        yield { type: 'text', text: 'hi' };
        yield { type: 'usage', inputTokens: 12, outputTokens: 3 };
        yield { type: 'end' };
      })();
    },
  };
  const session = new Session({ model, tools: [] });

  const events: SessionEvent[] = [];
  session.subscribe((event) => events.push(event));

  await session.submit('hello');

  const usage = events.find((event) => event.type === 'usage');
  assert.ok(usage, 'a usage event was emitted');
  assert.equal(
    (usage as Extract<SessionEvent, { type: 'usage' }>).inputTokens,
    12,
  );
  assert.equal(
    (usage as Extract<SessionEvent, { type: 'usage' }>).outputTokens,
    3,
  );

  // The usage event mid-stream must not be mistaken for `end`: the text still
  // finalizes and the run completes.
  assert.equal((events.at(-1) as { status?: string }).status, 'completed');
  assert.ok(
    events.some(
      (event) => event.type === 'message' && event.content === 'hi',
    ),
  );
});
