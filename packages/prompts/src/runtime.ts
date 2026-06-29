import type { SystemPrompt } from "./system/types";
import { asSystemPrompt } from "./system/types";

export type RequestAugmentContext = {
  browserMode?: boolean;
  coordinatorMode?: boolean;
  mcpToolLoadingHint?: string | null;
  advisorHint?: string | null;
  extraSections?: readonly string[];
};

export function augmentPromptForRequest(
  basePrompt: SystemPrompt,
  context: RequestAugmentContext,
): SystemPrompt {
  const sections = [
    ...(context.browserMode
      ? [
          `# Browser Mode
TODO: Describe browser automation constraints, startup steps, and stop conditions.`,
        ]
      : []),
    ...(context.coordinatorMode
      ? [
          `# Coordinator Mode
TODO: Describe delegation strategy, anti-duplication rules, and how to combine subagent results.`,
        ]
      : []),
    ...(context.mcpToolLoadingHint ? [context.mcpToolLoadingHint] : []),
    ...(context.advisorHint ? [context.advisorHint] : []),
    ...basePrompt,
    ...(context.extraSections ?? []),
  ].filter((section): section is string => Boolean(section));

  return asSystemPrompt(sections);
}
