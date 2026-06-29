import {
  arrayField,
  objectField,
  objectSchema,
  optionalField,
  stringField,
} from "../core/schema.js";
import { buildTool, type RuntimeContext, type TodoItem, type Tool } from "../core/tool.js";

function textResult(toolUseId: string, content: string) {
  return { toolUseId, content };
}

function ensureMessages(context: RuntimeContext): string[] {
  if (!context.messages) context.messages = [];
  return context.messages;
}

function ensureWorktrees(context: RuntimeContext): string[] {
  if (!context.worktrees) context.worktrees = [];
  return context.worktrees;
}

const todoWriteSchema = objectSchema({ todos: arrayField(objectField()) });
const questionSchema = objectSchema({ question: stringField(), options: optionalField(arrayField(objectField())) });
const planSchema = objectSchema({ plan: optionalField(stringField()) });
const messageSchema = objectSchema({ message: stringField() });
const configSchema = objectSchema({ key: stringField(), value: optionalField(objectField()) });
const skillSchema = objectSchema({ name: stringField(), input: optionalField(objectField()) });
const worktreeSchema = objectSchema({ path: stringField() });
const structuredOutputSchema = objectSchema({ value: objectField() });

export const TodoWriteTool = buildTool({
  name: "TodoWrite",
  inputSchema: todoWriteSchema,
  async call(input, context) {
    context.todos = input.todos.map((todo, index): TodoItem => ({
      id: typeof todo.id === "string" ? todo.id : String(index + 1),
      content: typeof todo.content === "string" ? todo.content : JSON.stringify(todo),
      status: typeof todo.status === "string" ? todo.status : "pending",
      priority: typeof todo.priority === "string" ? todo.priority : undefined,
    }));
    return { data: context.todos };
  },
  mapResult(data, toolUseId) {
    return textResult(toolUseId, "Stored " + data.length + " todos.");
  },
});

export const AskUserQuestionTool = buildTool({
  name: "AskUserQuestion",
  inputSchema: questionSchema,
  async call(input, context) {
    const options = input.options?.map((option) => String(option.label ?? option.value ?? "option")).join(", ");
    const rendered = options ? input.question + " Options: " + options : input.question;
    ensureMessages(context).push("question: " + rendered);
    return { data: rendered };
  },
  mapResult(data, toolUseId) {
    return textResult(toolUseId, "Question queued: " + data);
  },
});

export const EnterPlanModeTool = buildTool({
  name: "EnterPlanMode",
  inputSchema: planSchema,
  async call(input, context) {
    context.planMode = true;
    if (input.plan) context.lastPlan = input.plan;
    return { data: context.lastPlan ?? "plan mode entered" };
  },
  mapResult(data, toolUseId) {
    return textResult(toolUseId, "Entered plan mode: " + data);
  },
});

export const ExitPlanModeTool = buildTool({
  name: "ExitPlanMode",
  inputSchema: planSchema,
  async call(input, context) {
    context.planMode = false;
    if (input.plan) context.lastPlan = input.plan;
    return { data: context.lastPlan ?? "plan approved" };
  },
  mapResult(data, toolUseId) {
    return textResult(toolUseId, "Exited plan mode: " + data);
  },
});

export const BriefTool = buildTool({
  name: "SendUserMessage",
  aliases: ["Brief"],
  inputSchema: messageSchema,
  async call(input, context) {
    ensureMessages(context).push(input.message);
    return { data: input.message };
  },
  mapResult(data, toolUseId) {
    return textResult(toolUseId, data);
  },
});

export const ConfigTool = buildTool({
  name: "Config",
  inputSchema: configSchema,
  async call(input, context) {
    if (!context.config) context.config = new Map();
    if (input.value !== undefined) context.config.set(input.key, input.value);
    return { data: JSON.stringify(context.config.get(input.key) ?? null) };
  },
  mapResult(data, toolUseId) {
    return textResult(toolUseId, data);
  },
});

export const SkillTool = buildTool({
  name: "Skill",
  inputSchema: skillSchema,
  async call(input, context) {
    const body = context.skills?.get(input.name) ?? "Skill " + input.name + " is not installed; recorded invocation only.";
    return { data: body };
  },
  mapResult(data, toolUseId) {
    return textResult(toolUseId, data);
  },
});

export const EnterWorktreeTool = buildTool({
  name: "EnterWorktree",
  inputSchema: worktreeSchema,
  async call(input, context) {
    ensureWorktrees(context).push(input.path);
    context.cwd = input.path;
    return { data: input.path };
  },
  mapResult(data, toolUseId) {
    return textResult(toolUseId, "Entered worktree " + data);
  },
});

export const ExitWorktreeTool = buildTool({
  name: "ExitWorktree",
  inputSchema: objectSchema({}),
  async call(_input, context) {
    const path = ensureWorktrees(context).pop() ?? context.cwd ?? "";
    return { data: path };
  },
  mapResult(data, toolUseId) {
    return textResult(toolUseId, "Exited worktree " + data);
  },
});

export const StructuredOutputTool = buildTool({
  name: "StructuredOutput",
  inputSchema: structuredOutputSchema,
  async call(input) {
    return { data: JSON.stringify(input.value) };
  },
  mapResult(data, toolUseId) {
    return textResult(toolUseId, data);
  },
});

export const VerifyPlanExecutionTool = buildTool({
  name: "VerifyPlanExecution",
  inputSchema: planSchema,
  async call(input, context) {
    return { data: input.plan ?? context.lastPlan ?? "No plan supplied." };
  },
  mapResult(data, toolUseId) {
    return textResult(toolUseId, "Plan verification recorded: " + data);
  },
});

export function createWorkflowTools(): Tool[] {
  return [
    TodoWriteTool,
    AskUserQuestionTool,
    EnterPlanModeTool,
    ExitPlanModeTool,
    BriefTool,
    ConfigTool,
    SkillTool,
    EnterWorktreeTool,
    ExitWorktreeTool,
    StructuredOutputTool,
    VerifyPlanExecutionTool,
  ];
}
