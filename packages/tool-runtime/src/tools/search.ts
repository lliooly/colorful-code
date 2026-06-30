import { spawn } from "node:child_process";
import { resolve } from "node:path";
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

async function runRipgrep(
  args: string[],
  cwd: string,
  signal: AbortSignal | undefined,
): Promise<string[]> {
  return await new Promise((resolveOutput, reject) => {
    const child = spawn(
      "rg",
      ["--color", "never", "--null", "--no-require-git", ...args],
      {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        signal,
      },
    );
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        reject(new Error("ripgrep (rg) is required for Glob and Grep tools"));
        return;
      }
      reject(error);
    });
    child.on("close", (code) => {
      if (code !== 0 && code !== 1) {
        const message = Buffer.concat(stderr).toString("utf8").trim();
        reject(new Error(message || "ripgrep exited with code " + code));
        return;
      }
      const output = Buffer.concat(stdout).toString("utf8");
      const matches = output.split("\0").filter(Boolean);
      resolveOutput(matches.map((file) => resolve(cwd, file)).sort());
    });
  });
}

export const GlobTool = buildTool<GlobInput, SearchOutput>({
  name: "Glob",
  inputSchema: globInputSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  async call(input, context) {
    const root = baseDir(input.cwd, context);
    const matches = await runRipgrep(
      ["--files", "-g", input.pattern],
      root,
      context.signal,
    );
    return { data: { matches } };
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
    const matches = await runRipgrep(
      ["--files-with-matches", "-e", input.pattern],
      root,
      context.signal,
    );
    return { data: { matches } };
  },
  mapResult(data, toolUseId) {
    return { toolUseId, content: data.matches.join("\n") };
  },
});

export function createSearchTools(): Tool[] {
  return [GlobTool, GrepTool];
}
