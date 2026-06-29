import type {
  PromptSection,
  PromptSectionCache,
  PromptSectionComputeContext,
} from "./types";

export function cachedSection(
  name: string,
  compute: PromptSection["compute"],
): PromptSection {
  return {
    name,
    cacheBreak: false,
    compute,
  };
}

export function uncachedSection(
  name: string,
  compute: PromptSection["compute"],
): PromptSection {
  return {
    name,
    cacheBreak: true,
    compute,
  };
}

export async function resolvePromptSections(
  sections: readonly PromptSection[],
  context: PromptSectionComputeContext = {},
  cache: PromptSectionCache = new Map(),
): Promise<(string | null)[]> {
  return Promise.all(
    sections.map(async section => {
      if (!section.cacheBreak && cache.has(section.name)) {
        return cache.get(section.name) ?? null;
      }

      const value = await section.compute(context);
      cache.set(section.name, value);
      return value;
    }),
  );
}

export function clearPromptSectionCache(cache: PromptSectionCache): void {
  cache.clear();
}
