import { DEFAULT_WORKFLOW_PROMPTS } from '@colorful-code/prompts';
import type { CompactionConfig } from '@colorful-code/tool-runtime';
import type { ModelSelection } from './model-factory';

// Builds the automatic context-compaction policy for a session. The summary
// instruction is the shared `compact` workflow prompt; the token budget is
// derived from the selected model's context window. Compaction triggers at 80%
// of the window and preserves roughly the most recent 30% verbatim, folding
// everything older into a single summary.

// Conservative per-preset context windows (tokens). The default covers custom /
// unknown selections; it errs small so compaction triggers a little early rather
// than overrunning a smaller window.
const DEFAULT_CONTEXT_WINDOW = 128_000;
const CONTEXT_WINDOWS: Readonly<Record<string, number>> = {
  claude: 200_000,
  deepseek: 64_000,
  openai: 128_000
};

const COMPACTION_THRESHOLD = 0.8;
const KEEP_RECENT_FRACTION = 0.3;

export function resolveContextWindow(selection?: ModelSelection): number {
  const preset = selection?.preset ?? 'claude';
  return CONTEXT_WINDOWS[preset] ?? DEFAULT_CONTEXT_WINDOW;
}

export function buildCompactionConfig(
  selection?: ModelSelection
): CompactionConfig {
  const contextWindow = resolveContextWindow(selection);
  return {
    contextWindow,
    threshold: COMPACTION_THRESHOLD,
    keepRecentTokens: Math.floor(contextWindow * KEEP_RECENT_FRACTION),
    prompt: DEFAULT_WORKFLOW_PROMPTS.compact.prompt
  };
}
