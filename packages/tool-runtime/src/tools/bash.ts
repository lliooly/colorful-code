import { spawn } from "node:child_process";
import { objectSchema, optionalField, numberField, stringField } from "../core/schema.js";
import { buildTool, type Tool } from "../core/tool.js";

const bashInputSchema = objectSchema({
  command: stringField(),
  timeoutMs: optionalField(numberField()),
});

type BashInput = ReturnType<typeof bashInputSchema.parse>;
type BashOutput = { stdout: string; stderr: string; code: number | null };

const READ_ONLY_COMMANDS = new Set([
  "cat",
  "head",
  "tail",
  "ls",
  "find",
  "grep",
  "rg",
  "pwd",
  "wc",
  "stat",
  "git status",
  "git diff",
  "git log",
]);

function firstCommand(command: string): string {
  return command.trim().split(/\s+/).slice(0, 2).join(" ");
}

function isReadOnlyCommand(command: string): boolean {
  const trimmed = command.trim();
  const first = trimmed.split(/\s+/)[0] ?? "";
  return READ_ONLY_COMMANDS.has(first) || READ_ONLY_COMMANDS.has(firstCommand(trimmed));
}

export const BashTool = buildTool<BashInput, BashOutput>({
  name: "Bash",
  inputSchema: bashInputSchema,
  isReadOnly(input) {
    return isReadOnlyCommand(input.command);
  },
  isConcurrencySafe(input) {
    return isReadOnlyCommand(input.command);
  },
  async call(input, context) {
    const timeoutMs = input.timeoutMs ?? 30_000;
    return await new Promise((resolve, reject) => {
      const child = spawn("sh", ["-lc", input.command], {
        cwd: context.cwd,
        signal: context.signal,
      });
      let stdout = "";
      let stderr = "";
      const timeout = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error("Command timed out after " + timeoutMs + "ms"));
      }, timeoutMs);

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.on("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.on("close", (code) => {
        clearTimeout(timeout);
        resolve({ data: { stdout, stderr, code } });
      });
    });
  },
  mapResult(data, toolUseId) {
    const content = [data.stdout.trimEnd(), data.stderr.trimEnd(), data.code === 0 ? "" : "Exit code " + data.code]
      .filter(Boolean)
      .join("\n");
    return { toolUseId, content, isError: data.code !== 0 };
  },
});

export function createBashTools(): Tool[] {
  return [BashTool];
}
