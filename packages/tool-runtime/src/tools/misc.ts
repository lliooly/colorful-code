import { setTimeout as delay } from "node:timers/promises";
import { spawn } from "node:child_process";
import { objectSchema, optionalField, stringField, numberField, objectField } from "../core/schema.js";
import { buildTool, type RuntimeContext, type Tool } from "../core/tool.js";

export const BUILTIN_TOOL_NAMES = [
  "Agent", "TaskOutput", "Bash", "Glob", "Grep", "ExitPlanMode", "Read", "Edit", "Write", "NotebookEdit",
  "WebFetch", "TodoWrite", "WebSearch", "TaskStop", "AskUserQuestion", "Skill", "EnterPlanMode", "Config",
  "TaskCreate", "TaskGet", "TaskUpdate", "TaskList", "EnterWorktree", "ExitWorktree", "SendMessage",
  "TeamCreate", "TeamDelete", "VerifyPlanExecution", "Sleep", "CronCreate", "CronDelete",
  "CronList", "SendUserMessage", "PowerShell", "Snip", "ListMcpResourcesTool", "ReadMcpResourceTool", "ToolSearch",
  "StructuredOutput", "McpAuth", "WebBrowser",
] as const;

function result(toolUseId: string, content: string, isError?: boolean) {
  return { toolUseId, content, ...(isError ? { isError: true } : {}) };
}

function ensureCron(context: RuntimeContext) {
  if (!context.cronJobs) context.cronJobs = new Map();
  return context.cronJobs;
}

const cronCreateSchema = objectSchema({ name: stringField(), schedule: stringField(), prompt: stringField() });
const idSchema = objectSchema({ id: stringField() });
const commandSchema = objectSchema({ command: stringField(), timeoutMs: optionalField(numberField()) });
const querySchema = objectSchema({ query: stringField() });
const sleepSchema = objectSchema({ durationMs: numberField() });
const messageSchema = objectSchema({ message: stringField() });
const fileSendSchema = objectSchema({ path: stringField(), note: optionalField(stringField()) });
const remoteSchema = objectSchema({ name: stringField(), payload: optionalField(objectField()) });
const monitorSchema = objectSchema({ command: optionalField(stringField()), note: optionalField(stringField()) });
const workflowSchema = objectSchema({ name: stringField(), input: optionalField(objectField()) });
const snipSchema = objectSchema({ label: stringField(), content: stringField() });

export const CronCreateTool = buildTool({
  name: "CronCreate",
  inputSchema: cronCreateSchema,
  async call(input, context) {
    const jobs = ensureCron(context);
    const id = "cron-" + String(jobs.size + 1);
    const job = { id, name: input.name, schedule: input.schedule, prompt: input.prompt, createdAt: Date.now() };
    jobs.set(id, job);
    return { data: job };
  },
  mapResult(data, toolUseId) {
    return result(toolUseId, "Created cron " + data.name + " (" + data.id + ")");
  },
});

export const CronDeleteTool = buildTool({
  name: "CronDelete",
  inputSchema: idSchema,
  async call(input, context) {
    return { data: ensureCron(context).delete(input.id) };
  },
  mapResult(data, toolUseId) {
    return result(toolUseId, data ? "Cron deleted" : "Cron not found", !data);
  },
});

export const CronListTool = buildTool({
  name: "CronList",
  inputSchema: objectSchema({}),
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  async call(_input, context) {
    return { data: [...ensureCron(context).values()] };
  },
  mapResult(data, toolUseId) {
    return result(toolUseId, data.map((job) => job.id + " " + job.name + " " + job.schedule).join("\n"));
  },
});

export const ToolSearchTool = buildTool({
  name: "ToolSearch",
  inputSchema: querySchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  async call(input, context) {
    const q = input.query.toLowerCase();
    const names = context.toolNames ?? BUILTIN_TOOL_NAMES;
    return { data: names.filter((name) => name.toLowerCase().includes(q)) };
  },
  mapResult(data, toolUseId) {
    return result(toolUseId, data.join("\n"));
  },
});

export const PowerShellTool = buildTool({
  name: "PowerShell",
  inputSchema: commandSchema,
  async call(input, context) {
    return await new Promise<{ data: string }>((resolve) => {
      const shell = process.platform === "win32" ? "powershell.exe" : "pwsh";
      const child = spawn(shell, ["-NoProfile", "-Command", input.command], { cwd: context.cwd, signal: context.signal });
      let stdout = "";
      let stderr = "";
      const timeout = setTimeout(() => {
        child.kill();
        resolve({ data: "PowerShell command timed out" });
      }, input.timeoutMs ?? 30_000);
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("error", (error) => {
        clearTimeout(timeout);
        resolve({ data: "PowerShell unavailable: " + error.message });
      });
      child.on("close", (code) => {
        clearTimeout(timeout);
        resolve({ data: [stdout.trimEnd(), stderr.trimEnd(), code === 0 ? "" : "Exit code " + code].filter(Boolean).join("\n") });
      });
    });
  },
  mapResult(data, toolUseId) {
    return result(toolUseId, data);
  },
});

export const SleepTool = buildTool({
  name: "Sleep",
  inputSchema: sleepSchema,
  validateInput(input) {
    if (input.durationMs > 60_000) {
      return { ok: false, message: "Refusing to sleep longer than 60000ms; use background execution instead." };
    }
    return { ok: true };
  },
  async call(input, context) {
    await delay(Math.max(0, input.durationMs), undefined, { signal: context.signal });
    return { data: "Slept for " + input.durationMs + "ms" };
  },
  mapResult(data, toolUseId) {
    return result(toolUseId, data);
  },
});

function notificationTool(name: string, prefix: string): Tool {
  return buildTool({
    name,
    inputSchema: messageSchema,
    async call(input, context) {
      if (!context.notifications) context.notifications = [];
      context.notifications.push(prefix + input.message);
      return { data: prefix + input.message };
    },
    mapResult(data, toolUseId) {
      return result(toolUseId, data);
    },
  });
}

export const PushNotificationTool = notificationTool("PushNotification", "push: ");
export const SubscribePRTool = notificationTool("SubscribePR", "subscribe-pr: ");
export const SuggestBackgroundPRTool = notificationTool("SuggestBackgroundPR", "suggest-background-pr: ");
export const RemoteTriggerTool = buildTool({
  name: "RemoteTrigger",
  inputSchema: remoteSchema,
  async call(input, context) {
    if (!context.messages) context.messages = [];
    context.messages.push("remote:" + input.name + ":" + JSON.stringify(input.payload ?? {}));
    return { data: "Triggered remote action " + input.name };
  },
  mapResult(data, toolUseId) {
    return result(toolUseId, data);
  },
});

export const SendUserFileTool = buildTool({
  name: "SendUserFile",
  inputSchema: fileSendSchema,
  async call(input, context) {
    if (!context.messages) context.messages = [];
    const message = "file:" + input.path + (input.note ? ":" + input.note : "");
    context.messages.push(message);
    return { data: message };
  },
  mapResult(data, toolUseId) {
    return result(toolUseId, data);
  },
});

export const LSPTool = buildTool({
  name: "LSP",
  inputSchema: querySchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  async call(input) {
    return { data: "No LSP server configured. Query: " + input.query };
  },
  mapResult(data, toolUseId) {
    return result(toolUseId, data);
  },
});

export const MonitorTool = buildTool({
  name: "Monitor",
  inputSchema: monitorSchema,
  isReadOnly: () => true,
  async call(input) {
    return { data: "Monitor registered: " + (input.command ?? input.note ?? "idle") };
  },
  mapResult(data, toolUseId) {
    return result(toolUseId, data);
  },
});

export const REPLTool = buildTool({
  name: "REPL",
  inputSchema: commandSchema,
  async call(input) {
    return { data: "REPL command recorded: " + input.command };
  },
  mapResult(data, toolUseId) {
    return result(toolUseId, data);
  },
});

export const WorkflowTool = buildTool({
  name: "Workflow",
  inputSchema: workflowSchema,
  async call(input) {
    return { data: "Workflow " + input.name + " invoked with " + JSON.stringify(input.input ?? {}) };
  },
  mapResult(data, toolUseId) {
    return result(toolUseId, data);
  },
});

export const SnipTool = buildTool({
  name: "Snip",
  inputSchema: snipSchema,
  async call(input, context) {
    if (!context.config) context.config = new Map();
    context.config.set("snip:" + input.label, input.content);
    return { data: input.label };
  },
  mapResult(data, toolUseId) {
    return result(toolUseId, "Stored snip " + data);
  },
});

function simpleReadOnlyTool(name: string, message: string): Tool {
  return buildTool({
    name,
    inputSchema: objectSchema({}),
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    async call() {
      return { data: message };
    },
    mapResult(data, toolUseId) {
      return result(toolUseId, data);
    },
  });
}

export const TestingPermissionTool = simpleReadOnlyTool("TestingPermission", "Testing permission accepted.");
export const TerminalCaptureTool = simpleReadOnlyTool("TerminalCapture", "No terminal capture provider configured.");
export const CtxInspectTool = simpleReadOnlyTool("CtxInspect", "Context inspection provider not configured.");
export const ListPeersTool = simpleReadOnlyTool("ListPeers", "No peers connected.");
export const OverflowTestTool = simpleReadOnlyTool("OverflowTestTool", "Overflow test tool is available.");
export const TungstenTool = simpleReadOnlyTool("Tungsten", "Tungsten provider not configured.");

export function createMiscTools(): Tool[] {
  return [
    CronCreateTool,
    CronDeleteTool,
    CronListTool,
    ToolSearchTool,
    PowerShellTool,
    SleepTool,
    SnipTool,
  ];
}
