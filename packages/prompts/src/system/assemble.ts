import {
  resolvePromptSections,
} from "./sections";
import type {
  BuildEffectiveSystemPromptOptions,
  BuildPromptBlocksOptions,
  BuildSystemPromptOptions,
  PromptTextBlock,
  SystemPrompt,
} from "./types";
import { asSystemPrompt } from "./types";
import { SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from "./defaults";

export async function buildSystemPrompt(
  options: BuildSystemPromptOptions,
): Promise<SystemPrompt> {
  const resolvedDynamicSections = await resolvePromptSections(
    options.dynamicSections,
    options.sectionContext,
    options.sectionCache,
  );

  return asSystemPrompt(
    [
      ...options.staticSections,
      options.dynamicBoundary ?? SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
      ...resolvedDynamicSections,
    ].filter((section): section is string => Boolean(section)),
  );
}

export function buildEffectiveSystemPrompt(
  options: BuildEffectiveSystemPromptOptions,
): SystemPrompt {
  if (options.overridePrompt) {
    return asSystemPrompt([options.overridePrompt]);
  }

  const base =
    options.agentPrompt ?? options.customPrompt ?? options.defaultPrompt;

  return asSystemPrompt(
    [
      ...base,
      options.appendPrompt,
    ].filter((section): section is string => Boolean(section)),
  );
}

export function buildPromptBlocks(
  options: BuildPromptBlocksOptions,
): PromptTextBlock[] {
  const blocks: PromptTextBlock[] = [];
  let inDynamicTail = false;

  for (const part of options.prompt) {
    if (part === (options.dynamicBoundary ?? SYSTEM_PROMPT_DYNAMIC_BOUNDARY)) {
      inDynamicTail = true;
      continue;
    }

    blocks.push({
      type: "text",
      text: part,
      cacheScope: inDynamicTail
        ? options.dynamicCacheScope ?? "session"
        : options.staticCacheScope ?? "global",
    });
  }

  return blocks;
}
