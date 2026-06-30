import type { ToolDescriptor } from '../core/descriptor.js';
import type { ConversationEntry, ModelClient } from './model.js';
import { contentToText, prependTextToContent } from './content.js';

// Automatic context compaction. A long-running session's history grows without
// bound; every turn re-sends the full transcript, so an untended session
// eventually overruns the model's context window. This module estimates the
// prompt size each round and, past a threshold, replaces the older portion of
// the history with a model-written summary — preserving the most recent turns
// verbatim. The turn loop owns the trigger; everything here is otherwise pure
// (the one impure step, generating the summary, goes through the injected
// `ModelClient`).

// Maps a string to an approximate token count. Pluggable so a real tokenizer can
// be swapped in; the default is the conventional ~4-characters-per-token
// heuristic, which is deterministic (good for tests) and provider-agnostic.
export type TokenEstimator = (text: string) => number;

export const defaultEstimateTokens: TokenEstimator = (text) =>
  Math.ceil(text.length / 4);

// Compaction policy. `contextWindow` is the model's total token budget;
// compaction triggers once the estimated prompt reaches `threshold` of it.
// `keepRecentTokens` is how much of the most recent transcript is preserved
// verbatim (the rest is summarized). `prompt` is the summarization instruction
// (the caller supplies it, e.g. from `@colorful-code/prompts`).
export type CompactionConfig = {
  contextWindow: number;
  threshold: number;
  keepRecentTokens: number;
  prompt: string;
  estimateTokens?: TokenEstimator;
};

// Framing for the merged summary so the model reads it as authoritative context
// for everything that preceded the preserved tail, not as user instructions.
const SUMMARY_PREAMBLE =
  'The earlier part of this conversation was automatically summarized to stay ' +
  'within the context window. Treat the summary below as an authoritative ' +
  'record of everything that came before.\n\n<conversation-summary>\n';
const SUMMARY_SEPARATOR =
  "\n</conversation-summary>\n\nThe user's most recent request follows.\n\n";
// Appended to the to-summarize slice to force a fresh summary turn from the
// model (the slice always ends on an assistant turn, so this alternates cleanly).
const SUMMARY_REQUEST =
  'Summarize the conversation so far following the instructions in the system ' +
  'prompt. Output only the summary.';

// Flattens an entry to the text that will be sent to the provider, so the
// estimate tracks the real prompt: message content plus each tool call's name +
// serialized arguments and each tool result's content.
function entryToText(entry: ConversationEntry): string {
  let text = contentToText(entry.content);
  for (const call of entry.toolCalls ?? []) {
    text += '\n' + call.name + ' ' + JSON.stringify(call.input);
  }
  for (const result of entry.toolResults ?? []) {
    text += '\n' + contentToText(result.content);
  }
  return text;
}

export function estimateEntryTokens(
  entry: ConversationEntry,
  estimate: TokenEstimator = defaultEstimateTokens,
): number {
  return estimate(entryToText(entry));
}

export function estimateHistoryTokens(
  history: readonly ConversationEntry[],
  estimate: TokenEstimator = defaultEstimateTokens,
): number {
  let total = 0;
  for (const entry of history) {
    total += estimateEntryTokens(entry, estimate);
  }
  return total;
}

// Estimates the full prompt the next completion would send: the system prompt,
// the serialized tool descriptors, and the whole history. This is what the
// trigger compares against the window.
export function estimatePromptTokens(input: {
  history: readonly ConversationEntry[];
  system?: string;
  tools?: readonly ToolDescriptor[];
  estimate?: TokenEstimator;
}): number {
  const estimate = input.estimate ?? defaultEstimateTokens;
  let total = estimateHistoryTokens(input.history, estimate);
  if (input.system) {
    total += estimate(input.system);
  }
  if (input.tools && input.tools.length > 0) {
    total += estimate(JSON.stringify(input.tools));
  }
  return total;
}

export function shouldCompact(
  promptTokens: number,
  config: CompactionConfig,
): boolean {
  return promptTokens >= config.contextWindow * config.threshold;
}

// Chooses where to cut the history: the earliest `user` entry whose suffix still
// fits within `keepRecentTokens`, so the recent tail is preserved verbatim and
// the summary folds into that user message (keeping provider role-alternation
// valid and never orphaning a tool_use/tool_result pair). Returns 0 when there
// is nothing safe to summarize — no earlier user boundary exists (e.g. a single
// in-progress turn already larger than the budget), so the caller skips
// compaction this round.
export function selectCompactionBoundary(
  history: readonly ConversationEntry[],
  keepRecentTokens: number,
  estimate: TokenEstimator = defaultEstimateTokens,
): number {
  let candidate = -1;
  let acc = 0;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    acc += estimateEntryTokens(history[i]!, estimate);
    if (history[i]!.role === 'user') {
      if (acc <= keepRecentTokens) {
        candidate = i;
      } else {
        // This user turn (and everything after it) already exceeds the budget.
        // Keep it anyway if nothing smaller fit, then stop: earlier boundaries
        // would only be larger.
        if (candidate === -1) {
          candidate = i;
        }
        break;
      }
    }
  }
  return candidate < 0 ? 0 : candidate;
}

export type CompactionResult = {
  tokensBefore: number;
  tokensAfter: number;
  entriesSummarized: number;
  summary: string;
};

// Runs one completion with the compaction prompt as the system channel over the
// slice to summarize, returning the concatenated text. No tools are offered, so
// the model can only answer with prose. Respects the abort signal.
async function summarize(
  model: ModelClient,
  config: CompactionConfig,
  prefix: ConversationEntry[],
  signal: AbortSignal,
): Promise<string> {
  const request: ConversationEntry[] = [
    ...prefix,
    { role: 'user', content: SUMMARY_REQUEST },
  ];
  let summary = '';
  const stream = model.run({
    history: request,
    tools: [],
    signal,
    system: config.prompt,
  });
  for await (const event of stream) {
    if (signal.aborted) {
      break;
    }
    if (event.type === 'text') {
      summary += event.text;
    } else if (event.type === 'end') {
      break;
    }
  }
  return summary.trim();
}

// Compacts `history` in place: summarizes everything before the chosen boundary
// and folds the summary into the boundary user message, leaving the recent tail
// untouched. Returns the before/after token estimates and the summary, or
// `null` when there is nothing to compact (no boundary) or the summary came back
// empty / the run was aborted — in which case the history is left unchanged.
export async function compactHistory(params: {
  history: ConversationEntry[];
  model: ModelClient;
  config: CompactionConfig;
  system?: string;
  tools?: readonly ToolDescriptor[];
  signal: AbortSignal;
}): Promise<CompactionResult | null> {
  const estimate = params.config.estimateTokens ?? defaultEstimateTokens;
  const boundary = selectCompactionBoundary(
    params.history,
    params.config.keepRecentTokens,
    estimate,
  );
  if (boundary <= 0) {
    return null;
  }

  const tokensBefore = estimatePromptTokens({
    history: params.history,
    ...(params.system !== undefined ? { system: params.system } : {}),
    ...(params.tools !== undefined ? { tools: params.tools } : {}),
    estimate,
  });

  const prefix = params.history.slice(0, boundary);
  const boundaryUser = params.history[boundary]!;
  const summary = await summarize(
    params.model,
    params.config,
    prefix,
    params.signal,
  );
  if (params.signal.aborted || summary.length === 0) {
    return null;
  }

  const merged: ConversationEntry = {
    role: 'user',
    content: prependTextToContent(
      SUMMARY_PREAMBLE + summary + SUMMARY_SEPARATOR,
      boundaryUser.content,
    ),
  };
  // Replace [0 .. boundary] (the summarized prefix + the boundary user message)
  // with the single merged user message. The tail that follows starts with the
  // boundary user's assistant reply, so alternation stays valid.
  params.history.splice(0, boundary + 1, merged);

  const tokensAfter = estimatePromptTokens({
    history: params.history,
    ...(params.system !== undefined ? { system: params.system } : {}),
    ...(params.tools !== undefined ? { tools: params.tools } : {}),
    estimate,
  });

  return { tokensBefore, tokensAfter, entriesSummarized: boundary, summary };
}
