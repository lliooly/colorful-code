import type { Schema, ToolInputJSONSchema } from './schema.js';
import type { McpManager } from '../mcp/types.js';
import type {
  PermissionAuditEntry,
  PermissionContext,
  PermissionResult,
  RequestApproval,
} from './permissions.js';

export type JsonObject = Record<string, unknown>;

export type ToolSource = 'builtin' | 'mcp' | 'lsp';

export type ToolResultBlock = {
  toolUseId: string;
  content: string;
  isError?: boolean;
};

export type ToolCallResult<Output> = {
  data: Output;
};

// The permission types now live in `permissions.ts`. `PermissionResult` is the
// three-state verdict (allow | deny | ask); `PermissionDecision` is kept as a
// backwards-compatible alias for callers that still reference the old name.
export type { PermissionResult } from './permissions.js';
export type PermissionDecision<Input extends JsonObject = JsonObject> =
  PermissionResult<Input>;

export type ValidationResult = { ok: true } | { ok: false; message: string };

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

export type RuntimeBackgroundProcess = {
  id: string;
  command: string;
  cwd?: string;
  pid?: number;
  status: 'running' | 'exited' | 'error';
  stdout: string;
  stderr: string;
  code: number | null;
  signal: string | null;
  error?: string;
  startedAt: number;
  updatedAt: number;
  kill(signal?: NodeJS.Signals): boolean;
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
  backgroundProcesses?: Map<string, RuntimeBackgroundProcess>;
  teams?: Map<string, { id: string; name: string; members: string[] }>;
  mcpResources?: Map<string, McpResource>;
  mcpManager?: McpManager;
  cronJobs?: Map<string, CronJob>;
  config?: Map<string, unknown>;
  skills?: Map<string, string>;
  messages?: string[];
  notifications?: string[];
  worktrees?: string[];
  toolNames?: string[];
  planMode?: boolean;
  lastPlan?: string;
  // The layered permission context (mode, workspace roots, rules, MCP trust)
  // consulted by `evaluatePermission`. Provided by the session (Pillar 3).
  permissionContext?: PermissionContext;
  // Approval port used by the runner when a decision resolves to `ask`. Absent
  // means headless: an `ask` becomes a `deny`.
  requestApproval?: RequestApproval;
  // Append-only audit log; the runner pushes one entry per permission decision.
  permissionAudit?: PermissionAuditEntry[];
  permissionPolicy?: (
    tool: Tool<JsonObject, unknown>,
    input: JsonObject,
    context: RuntimeContext,
  ) => Promise<PermissionResult> | PermissionResult;
  webFetchProvider?: (url: string) => Promise<string>;
  webSearchProvider?: (query: string) => Promise<string[]>;
  webBrowserProvider?: (url: string) => Promise<string>;
  mcpToolProvider?: (
    server: string,
    tool: string,
    args: JsonObject,
  ) => Promise<unknown>;
};

export type Tool<Input extends JsonObject = JsonObject, Output = unknown> = {
  name: string;
  aliases?: string[];
  description?: string;
  searchHint?: string;
  inputSchema: Schema<Input>;
  inputJSONSchema?: ToolInputJSONSchema;
  source?: ToolSource;
  call(input: Input, context: RuntimeContext): Promise<ToolCallResult<Output>>;
  mapResult(data: Output, toolUseId: string): ToolResultBlock;
  validateInput?(
    input: Input,
    context: RuntimeContext,
  ): Promise<ValidationResult> | ValidationResult;
  checkPermissions(
    input: Input,
    context: RuntimeContext,
  ): Promise<PermissionResult<Input>> | PermissionResult<Input>;
  isEnabled(): boolean;
  isReadOnly(input: Input): boolean;
  isConcurrencySafe(input: Input): boolean;
  isDestructive(input: Input): boolean;
};

export type ToolDefinition<Input extends JsonObject, Output> = {
  name: string;
  aliases?: string[];
  description?: string;
  searchHint?: string;
  inputSchema: Schema<Input>;
  inputJSONSchema?: ToolInputJSONSchema;
  source?: ToolSource;
  call(input: Input, context: RuntimeContext): Promise<ToolCallResult<Output>>;
  mapResult(data: Output, toolUseId: string): ToolResultBlock;
  validateInput?(
    input: Input,
    context: RuntimeContext,
  ): Promise<ValidationResult> | ValidationResult;
  checkPermissions?(
    input: Input,
    context: RuntimeContext,
  ): Promise<PermissionResult<Input>> | PermissionResult<Input>;
  isEnabled?(): boolean;
  isReadOnly?(input: Input): boolean;
  isConcurrencySafe?(input: Input): boolean;
  isDestructive?(input: Input): boolean;
};

export const TOOL_RESULT_MAX_CHARS = 20_000;

export function truncateToolResultContent(
  content: string,
  maxChars = TOOL_RESULT_MAX_CHARS,
): string {
  if (content.length <= maxChars) {
    return content;
  }

  let notice = "\n\n[tool output truncated: showing head and tail]\n\n";
  let available = Math.max(0, maxChars - notice.length);
  let headChars = Math.ceil(available / 2);
  let tailChars = Math.floor(available / 2);
  let omittedChars = content.length - headChars - tailChars;

  notice =
    "\n\n[tool output truncated: omitted " +
    omittedChars +
    " characters; showing first " +
    headChars +
    " and last " +
    tailChars +
    " characters]\n\n";
  available = Math.max(0, maxChars - notice.length);
  headChars = Math.ceil(available / 2);
  tailChars = Math.floor(available / 2);
  omittedChars = content.length - headChars - tailChars;
  notice =
    "\n\n[tool output truncated: omitted " +
    omittedChars +
    " characters; showing first " +
    headChars +
    " and last " +
    tailChars +
    " characters]\n\n";

  return content.slice(0, headChars) + notice + content.slice(-tailChars);
}

export function buildTool<Input extends JsonObject, Output>(
  definition: ToolDefinition<Input, Output>,
): Tool<Input, Output> {
  return {
    ...definition,
    source: definition.source ?? 'builtin',
    checkPermissions:
      definition.checkPermissions ?? (() => ({ behavior: 'allow' as const })),
    isEnabled: definition.isEnabled ?? (() => true),
    isReadOnly: definition.isReadOnly ?? (() => false),
    isConcurrencySafe: definition.isConcurrencySafe ?? (() => false),
    isDestructive: definition.isDestructive ?? (() => false),
    mapResult(data, toolUseId) {
      const result = definition.mapResult(data, toolUseId);
      return {
        ...result,
        content: truncateToolResultContent(result.content),
      };
    },
  };
}

export function createRuntimeContext(
  overrides: RuntimeContext = {},
): RuntimeContext {
  return {
    fileState: new Map<string, FileReadSnapshot>(),
    todos: [],
    tasks: new Map<string, RuntimeTask>(),
    backgroundProcesses: new Map<string, RuntimeBackgroundProcess>(),
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
