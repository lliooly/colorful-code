import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { objectSchema, optionalField, stringField } from "../core/schema.js";
import { buildTool, type RuntimeContext, type Tool } from "../core/tool.js";

const globInputSchema = objectSchema({
  cwd: optionalField(stringField()),
  pattern: stringField(),
});
const grepInputSchema = objectSchema({
  cwd: optionalField(stringField()),
  pattern: stringField(),
});

type GlobInput = ReturnType<typeof globInputSchema.parse>;
type GrepInput = ReturnType<typeof grepInputSchema.parse>;

type SearchOutput = { matches: string[] };

function baseDir(inputCwd: string | undefined, context: RuntimeContext): string {
  return resolve(context.cwd ?? process.cwd(), inputCwd ?? ".");
}

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === ".git") {
      continue;
    }
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(fullPath)));
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }
  return files;
}

function matchesPattern(filePath: string, pattern: string): boolean {
  if (pattern === "**/*") {
    return true;
  }
  if (pattern.startsWith("**/*.")) {
    return filePath.endsWith(pattern.slice(4));
  }
  if (pattern.startsWith("*.")) {
    return basename(filePath).endsWith(pattern.slice(1));
  }
  return filePath.includes(pattern.replaceAll("*", ""));
}

export const GlobTool = buildTool<GlobInput, SearchOutput>({
  name: "Glob",
  inputSchema: globInputSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  async call(input, context) {
    const root = baseDir(input.cwd, context);
    const files = await walk(root);
    return { data: { matches: files.filter((file) => matchesPattern(file, input.pattern)).sort() } };
  },
  mapResult(data, toolUseId) {
    return { toolUseId, content: data.matches.join("\n") };
  },
});

export const GrepTool = buildTool<GrepInput, SearchOutput>({
  name: "Grep",
  inputSchema: grepInputSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  async call(input, context) {
    const root = baseDir(input.cwd, context);
    const files = await walk(root);
    const matches: string[] = [];
    for (const file of files) {
      const info = await stat(file);
      if (info.size > 1_000_000) {
        continue;
      }
      try {
        const content = await readFile(file, "utf8");
        if (content.includes(input.pattern)) {
          matches.push(file);
        }
      } catch {
        // Ignore non-text files in the first implementation.
      }
    }
    return { data: { matches: matches.sort() } };
  },
  mapResult(data, toolUseId) {
    return { toolUseId, content: data.matches.join("\n") };
  },
});

export function createSearchTools(): Tool[] {
  return [GlobTool, GrepTool];
}
