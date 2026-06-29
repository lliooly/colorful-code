export type PromptCacheScope = "global" | "session" | null;

export type PromptTextBlock = {
  type: "text";
  text: string;
  cacheScope?: PromptCacheScope;
};

export type PromptSectionComputeContext = {
  now?: Date;
  language?: string;
  environmentSummary?: string | null;
  memorySummary?: string | null;
  mcpInstructions?: string | null;
  outputStyle?: string | null;
  metadata?: Record<string, unknown>;
};

export type PromptSectionValue = string | null | Promise<string | null>;

export type PromptSection = {
  name: string;
  cacheBreak: boolean;
  compute: (context: PromptSectionComputeContext) => PromptSectionValue;
};

export type PromptSectionCache = Map<string, string | null>;

export type SystemPrompt = readonly string[] & {
  readonly __brand: "SystemPrompt";
};

export function asSystemPrompt(value: readonly string[]): SystemPrompt {
  return value as SystemPrompt;
}

export type BuildSystemPromptOptions = {
  staticSections: readonly string[];
  dynamicSections: readonly PromptSection[];
  sectionContext?: PromptSectionComputeContext;
  sectionCache?: PromptSectionCache;
  dynamicBoundary?: string;
};

export type BuildEffectiveSystemPromptOptions = {
  defaultPrompt: readonly string[];
  agentPrompt?: string | null;
  customPrompt?: string | null;
  appendPrompt?: string | null;
  overridePrompt?: string | null;
};

export type BuildPromptBlocksOptions = {
  prompt: SystemPrompt;
  dynamicBoundary?: string;
  staticCacheScope?: PromptCacheScope;
  dynamicCacheScope?: PromptCacheScope;
};
