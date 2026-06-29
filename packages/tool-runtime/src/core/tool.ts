import type { Schema } from "./schema.js";

export type JsonObject = Record<string, unknown>;

export type ToolResultBlock = {
  toolUseId: string;
  content: string;
  isError?: boolean;
};

export type ToolCallResult<Output> = {
  data: Output;
};

export type PermissionDecision<Input extends JsonObject = JsonObject> =
  | { behavior: "allow"; updatedInput?: Input }
  | { behavior: "deny"; message: string };

export type ValidationResult =
  | { ok: true }
  | { ok: false; message: string };

export type FileReadSnapshot = {
  content: string;
  mtimeMs: number;
  complete: boolean;
};

export type TodoItem = {
  id?: string;
  content: string;
  status: string;
  priority?: string;
};

export type RuntimeTask = {
  id: string;
  description: string;
  prompt: string;
  type?: string;
  status: string;
  output: string;
  messages: string[];
  createdAt: number;
  updatedAt: number;
};

export type McpResource = {
  uri: string;
  name?: string;
  content: string;
};

export type CronJob = {
  id: string;
  name: string;
  schedule: string;
  prompt: string;
  createdAt: number;
};

export type RuntimeContext = {
  signal?: AbortSignal;
  toolUseId?: string;
  cwd?: string;
  fileState?: Map<string, FileReadSnapshot>;
  todos?: TodoItem[];
  tasks?: Map<string, RuntimeTask>;
  teams?: Map<string, { id: string; name: string; members: string[] }>;
  mcpResources?: Map<string, McpResource>;
  cronJobs?: Map<string, CronJob>;
  config?: Map<string, unknown>;
  skills?: Map<string, string>;
  messages?: string[];
  notifications?: string[];
  worktrees?: string[];
  toolNames?: string[];
  planMode?: boolean;
  lastPlan?: string;
  permissionPolicy?: (
    tool: Tool<JsonObject, unknown>,
    input: JsonObject,
    context: RuntimeContext,
  ) => Promise<PermissionDecision> | PermissionDecision;
  webFetchProvider?: (url: string) => Promise<string>;
  webSearchProvider?: (query: string) => Promise<string[]>;
  mcpToolProvider?: (server: string, tool: string, args: JsonObject) => Promise<unknown>;
};

export type Tool<Input extends JsonObject = JsonObject, Output = unknown> = {
  name: string;
  aliases?: string[];
  inputSchema: Schema<Input>;
  call(input: Input, context: RuntimeContext): Promise<ToolCallResult<Output>>;
  mapResult(data: Output, toolUseId: string): ToolResultBlock;
  validateInput?(input: Input, context: RuntimeContext): Promise<ValidationResult> | ValidationResult;
  checkPermissions(input: Input, context: RuntimeContext): Promise<PermissionDecision<Input>> | PermissionDecision<Input>;
  isEnabled(): boolean;
  isReadOnly(input: Input): boolean;
  isConcurrencySafe(input: Input): boolean;
  isDestructive(input: Input): boolean;
};

export type ToolDefinition<Input extends JsonObject, Output> = {
  name: string;
  aliases?: string[];
  inputSchema: Schema<Input>;
  call(input: Input, context: RuntimeContext): Promise<ToolCallResult<Output>>;
  mapResult(data: Output, toolUseId: string): ToolResultBlock;
  validateInput?(input: Input, context: RuntimeContext): Promise<ValidationResult> | ValidationResult;
  checkPermissions?(input: Input, context: RuntimeContext): Promise<PermissionDecision<Input>> | PermissionDecision<Input>;
  isEnabled?(): boolean;
  isReadOnly?(input: Input): boolean;
  isConcurrencySafe?(input: Input): boolean;
  isDestructive?(input: Input): boolean;
};

export function buildTool<Input extends JsonObject, Output>(
  definition: ToolDefinition<Input, Output>,
): Tool<Input, Output> {
  return {
    ...definition,
    checkPermissions: definition.checkPermissions ?? (() => ({ behavior: "allow" as const })),
    isEnabled: definition.isEnabled ?? (() => true),
    isReadOnly: definition.isReadOnly ?? (() => false),
    isConcurrencySafe: definition.isConcurrencySafe ?? (() => false),
    isDestructive: definition.isDestructive ?? (() => false),
  };
}

export function createRuntimeContext(overrides: RuntimeContext = {}): RuntimeContext {
  return {
    fileState: new Map<string, FileReadSnapshot>(),
    todos: [],
    tasks: new Map<string, RuntimeTask>(),
    teams: new Map<string, { id: string; name: string; members: string[] }>(),
    mcpResources: new Map<string, McpResource>(),
    cronJobs: new Map<string, CronJob>(),
    config: new Map<string, unknown>(),
    skills: new Map<string, string>(),
    messages: [],
    notifications: [],
    worktrees: [],
    planMode: false,
    ...overrides,
  };
}
