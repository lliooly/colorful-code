import type { SystemPrompt } from "./system/types.js";
import { asSystemPrompt } from "./system/types.js";

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
Use browser automation when it helps inspect or verify the user's task. Prefer focused navigation, keep the user informed about visible state changes, and stop once the requested verification or action is complete.`,
        ]
      : []),
    ...(context.coordinatorMode
      ? [
          `# Coordinator Mode
Coordinate parallel work only when tasks are independent. Keep ownership boundaries clear, avoid duplicate edits, and combine results into one coherent status for the user.`,
        ]
      : []),
    ...(context.mcpToolLoadingHint ? [context.mcpToolLoadingHint] : []),
    ...(context.advisorHint ? [context.advisorHint] : []),
    ...basePrompt,
    ...(context.extraSections ?? []),
  ].filter((section): section is string => Boolean(section));

  return asSystemPrompt(sections);
}
