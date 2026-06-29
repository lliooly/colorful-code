import { arrayField, objectSchema, optionalField, stringField } from "../core/schema.js";
import { buildTool, type RuntimeContext, type RuntimeTask, type Tool } from "../core/tool.js";

function ensureTasks(context: RuntimeContext): Map<string, RuntimeTask> {
  if (!context.tasks) context.tasks = new Map();
  return context.tasks;
}

function taskId(prefix: string, context: RuntimeContext): string {
  let count = 0;
  for (const id of ensureTasks(context).keys()) {
    if (id.startsWith(prefix + "-")) count += 1;
  }
  return prefix + "-" + String(count + 1);
}

function getTask(context: RuntimeContext, id: string): RuntimeTask {
  const task = ensureTasks(context).get(id);
  if (!task) throw new Error("Task not found: " + id);
  return task;
}

function renderTask(task: RuntimeTask): string {
  return task.id + " [" + task.status + "] " + task.description + (task.output ? "\n" + task.output : "");
}

const createSchema = objectSchema({ description: stringField(), prompt: optionalField(stringField()), subagent_type: optionalField(stringField()) });
const idSchema = objectSchema({ id: stringField() });
const sendSchema = objectSchema({ to: stringField(), message: stringField() });
const updateSchema = objectSchema({ id: stringField(), status: optionalField(stringField()), output: optionalField(stringField()) });
const teamCreateSchema = objectSchema({ name: stringField(), members: optionalField(arrayField(stringField())) });

export const AgentTool = buildTool({
  name: "Agent",
  aliases: ["Task"],
  inputSchema: createSchema,
  async call(input, context) {
    const now = Date.now();
    const task: RuntimeTask = {
      id: taskId("agent", context),
      description: input.description,
      prompt: input.prompt ?? input.description,
      type: input.subagent_type,
      status: "running",
      output: "",
      messages: [],
      createdAt: now,
      updatedAt: now,
    };
    ensureTasks(context).set(task.id, task);
    return { data: task };
  },
  mapResult(data, toolUseId) {
    return { toolUseId, content: "Started agent " + renderTask(data) };
  },
});

export const TaskCreateTool = buildTool({
  name: "TaskCreate",
  inputSchema: createSchema,
  async call(input, context) {
    const now = Date.now();
    const task: RuntimeTask = {
      id: taskId("task", context),
      description: input.description,
      prompt: input.prompt ?? input.description,
      type: input.subagent_type,
      status: "pending",
      output: "",
      messages: [],
      createdAt: now,
      updatedAt: now,
    };
    ensureTasks(context).set(task.id, task);
    return { data: task };
  },
  mapResult(data, toolUseId) {
    return { toolUseId, content: "Created task " + renderTask(data) };
  },
});

export const SendMessageTool = buildTool({
  name: "SendMessage",
  inputSchema: sendSchema,
  async call(input, context) {
    const task = getTask(context, input.to);
    task.messages.push(input.message);
    task.updatedAt = Date.now();
    return { data: task };
  },
  mapResult(data, toolUseId) {
    return { toolUseId, content: "Sent message to " + data.id };
  },
});

export const TaskUpdateTool = buildTool({
  name: "TaskUpdate",
  inputSchema: updateSchema,
  async call(input, context) {
    const task = getTask(context, input.id);
    if (input.status) task.status = input.status;
    if (input.output !== undefined) task.output = input.output;
    task.updatedAt = Date.now();
    return { data: task };
  },
  mapResult(data, toolUseId) {
    return { toolUseId, content: "Updated task " + renderTask(data) };
  },
});

export const TaskGetTool = buildTool({
  name: "TaskGet",
  inputSchema: idSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  async call(input, context) {
    return { data: getTask(context, input.id) };
  },
  mapResult(data, toolUseId) {
    return { toolUseId, content: renderTask(data) };
  },
});

export const TaskOutputTool = buildTool({
  name: "TaskOutput",
  inputSchema: idSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  async call(input, context) {
    return { data: getTask(context, input.id).output };
  },
  mapResult(data, toolUseId) {
    return { toolUseId, content: data };
  },
});

export const TaskListTool = buildTool({
  name: "TaskList",
  inputSchema: objectSchema({}),
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  async call(_input, context) {
    return { data: [...ensureTasks(context).values()] };
  },
  mapResult(data, toolUseId) {
    return { toolUseId, content: data.map(renderTask).join("\n") };
  },
});

export const TaskStopTool = buildTool({
  name: "TaskStop",
  inputSchema: idSchema,
  async call(input, context) {
    const task = getTask(context, input.id);
    task.status = "stopped";
    task.updatedAt = Date.now();
    return { data: task };
  },
  mapResult(data, toolUseId) {
    return { toolUseId, content: "Task stopped: " + data.id };
  },
});

export const TeamCreateTool = buildTool({
  name: "TeamCreate",
  inputSchema: teamCreateSchema,
  async call(input, context) {
    if (!context.teams) context.teams = new Map();
    const id = "team-" + String(context.teams.size + 1);
    const team = { id, name: input.name, members: input.members ?? [] };
    context.teams.set(id, team);
    return { data: team };
  },
  mapResult(data, toolUseId) {
    return { toolUseId, content: "Created team " + data.name + " (" + data.id + ")" };
  },
});

export const TeamDeleteTool = buildTool({
  name: "TeamDelete",
  inputSchema: idSchema,
  async call(input, context) {
    const deleted = context.teams?.delete(input.id) ?? false;
    return { data: deleted ? input.id : "" };
  },
  mapResult(data, toolUseId) {
    return { toolUseId, content: data ? "Deleted team " + data : "Team not found" };
  },
});

export function createTaskTools(): Tool[] {
  return [
    AgentTool,
    TaskOutputTool,
    TaskStopTool,
    TaskCreateTool,
    TaskGetTool,
    TaskUpdateTool,
    TaskListTool,
    SendMessageTool,
    TeamCreateTool,
    TeamDeleteTool,
  ];
}
