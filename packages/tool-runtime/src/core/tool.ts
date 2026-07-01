import type { Schema, ToolInputJSONSchema } from './schema.js';
import type { McpManager } from '../mcp/types.js';
import type { LspManager } from '../lsp/types.js';
import type { HookAuditEntry, HookConfig, HookFailure } from './hooks.js';
import type {
  PermissionAuditEntry,
  PermissionContext,
  PermissionResult,
  RequestApproval,
} from './permissions.js';

export type JsonObject = Record<string, unknown>;

export type ToolSource = 'builtin' | 'mcp' | 'lsp';

export type ToolInvocationSource =
  | { type: 'mcp'; server: string }
  | { type: 'builtin' }
  | { type: 'lsp' };

export type McpToolBinding = {
  server: string;
  tool?: string;
};

export type ToolResultBlock = {
  toolUseId: string;
  content: string;
  isError?: boolean;
  metadata?: JsonObject;
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
  stale?: boolean;
};

export type PatchLineKind = 'context' | 'added' | 'removed';

export type PatchLine = {
  kind: PatchLineKind;
  oldNumber?: number;
  newNumber?: number;
  text: string;
};

export type FilePatchHunk = {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: PatchLine[];
};

export type FilePatch = {
  path: string;
  status: 'added' | 'modified' | 'deleted';
  hunks: FilePatchHunk[];
  added: number;
  removed: number;
  conflictReason?: string;
};

export type EditProposal = {
  id: string;
  toolUseId: string;
  createdAt: number;
  patches: FilePatch[];
  files: Array<{
    path: string;
    before: string;
    after: string;
    mtimeMs?: number;
    requireUnchanged: boolean;
  }>;
  status: 'proposed' | 'approved' | 'applied' | 'rejected' | 'conflict';
  conflictReason?: string;
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

export type RuntimeSubagentRequest = {
  description: string;
  prompt: string;
  type?: string;
};

export type RuntimeSubagentResult = {
  output: string;
  status: 'completed';
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
  editProposals?: Map<string, EditProposal>;
  proposeEdit?: (
    proposal: Omit<EditProposal, 'id' | 'createdAt' | 'status'>,
    context: RuntimeContext,
  ) => Promise<EditProposal> | EditProposal;
  approveEdit?: (proposal: EditProposal, context: RuntimeContext) => void;
  applyEdit?: (proposal: EditProposal, context: RuntimeContext) => void;
  rejectEdit?: (proposal: EditProposal, context: RuntimeContext) => void;
  conflictEdit?: (
    proposal: EditProposal,
    reason: string,
    context: RuntimeContext,
  ) => void;
  applyEditProposal?: (
    proposal: EditProposal,
    context: RuntimeContext,
  ) => Promise<void>;
  todos?: TodoItem[];
  tasks?: Map<string, RuntimeTask>;
  backgroundProcesses?: Map<string, RuntimeBackgroundProcess>;
  teams?: Map<string, { id: string; name: string; members: string[] }>;
  mcpResources?: Map<string, McpResource>;
  mcpManager?: McpManager;
  lspManager?: LspManager;
  cronJobs?: Map<string, CronJob>;
  config?: Map<string, unknown>;
  skills?: Map<string, string>;
  messages?: string[];
  notifications?: string[];
  worktrees?: string[];
  toolNames?: string[];
  planMode?: boolean;
  lastPlan?: string;
  subagentDepth?: number;
  maxSubagentDepth?: number;
  runSubagent?: (
    request: RuntimeSubagentRequest,
    context: RuntimeContext,
  ) => Promise<RuntimeSubagentResult>;
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
  hookConfig?: HookConfig;
  hookAudit?: HookAuditEntry[];
  emitHookEvent?: (entry: HookAuditEntry, context: RuntimeContext) => void;
  emitHookFailure?: (failure: HookFailure, context: RuntimeContext) => void;
  webFetchProvider?: (url: string) => Promise<string>;
  webSearchProvider?: (query: string) => Promise<string[]>;
  webSearchEndpoint?: string;
  webBrowserProvider?: (url: string) => Promise<string>;
  disableDefaultWebProviders?: boolean;
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
  mcp?: McpToolBinding;
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
  mcp?: McpToolBinding;
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

  let notice = '\n\n[tool output truncated: showing head and tail]\n\n';
  let available = Math.max(0, maxChars - notice.length);
  let headChars = Math.ceil(available / 2);
  let tailChars = Math.floor(available / 2);
  let omittedChars = content.length - headChars - tailChars;

  notice =
    '\n\n[tool output truncated: omitted ' +
    omittedChars +
    ' characters; showing first ' +
    headChars +
    ' and last ' +
    tailChars +
    ' characters]\n\n';
  available = Math.max(0, maxChars - notice.length);
  headChars = Math.ceil(available / 2);
  tailChars = Math.floor(available / 2);
  omittedChars = content.length - headChars - tailChars;
  notice =
    '\n\n[tool output truncated: omitted ' +
    omittedChars +
    ' characters; showing first ' +
    headChars +
    ' and last ' +
    tailChars +
    ' characters]\n\n';

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
  const defaultWebProviders =
    overrides.disableDefaultWebProviders === true
      ? {}
      : createDefaultWebProviders(overrides);
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
    ...defaultWebProviders,
    ...overrides,
  };
}

function createDefaultWebProviders(
  overrides: RuntimeContext,
): Pick<
  RuntimeContext,
  'webFetchProvider' | 'webSearchProvider' | 'webBrowserProvider'
> {
  const webFetchProvider = overrides.webFetchProvider ?? defaultWebFetch;
  return {
    webFetchProvider,
    webBrowserProvider: overrides.webBrowserProvider ?? webFetchProvider,
    webSearchProvider:
      overrides.webSearchProvider ??
      ((query: string) => defaultWebSearch(overrides.webSearchEndpoint, query)),
  };
}

async function defaultWebFetch(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      accept:
        'text/html,application/xhtml+xml,application/xml,text/plain,application/json;q=0.9,*/*;q=0.8',
      'user-agent': 'ColorfulCode/0.0 (+https://colorful-code.local)',
    },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      'WebFetch failed with HTTP ' +
        String(response.status) +
        ' ' +
        response.statusText +
        (text.length > 0 ? ': ' + text.slice(0, 500) : ''),
    );
  }
  return text;
}

async function defaultWebSearch(
  endpointTemplate: string | undefined,
  query: string,
): Promise<string[]> {
  const endpoint = endpointTemplate
    ? buildSearchEndpoint(endpointTemplate, query)
    : 'https://duckduckgo.com/html/?q=' + encodeURIComponent(query);
  const text = await defaultWebFetch(endpoint);
  const trimmed = text.trimStart();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return formatSearchPayload(JSON.parse(text));
  }
  return formatSearchHtml(text);
}

function buildSearchEndpoint(endpointTemplate: string, query: string): string {
  return endpointTemplate.includes('{query}')
    ? endpointTemplate.replaceAll('{query}', encodeURIComponent(query))
    : appendQuery(endpointTemplate, query);
}

function appendQuery(endpoint: string, query: string): string {
  const url = new URL(endpoint);
  if (!url.searchParams.has('q') && !url.searchParams.has('query')) {
    url.searchParams.set('q', query);
  }
  return url.toString();
}

function formatSearchPayload(payload: unknown): string[] {
  const candidates = Array.isArray(payload)
    ? payload
    : payload &&
        typeof payload === 'object' &&
        Array.isArray((payload as { results?: unknown }).results)
      ? (payload as { results: unknown[] }).results
      : [];
  return candidates.map(formatSearchResult).filter((line) => line.length > 0);
}

function formatSearchResult(result: unknown): string {
  if (typeof result === 'string') {
    return result;
  }
  if (!result || typeof result !== 'object') {
    return '';
  }
  const record = result as Record<string, unknown>;
  const title = stringValue(record.title) ?? stringValue(record.name);
  const url = stringValue(record.url) ?? stringValue(record.link);
  const snippet =
    stringValue(record.snippet) ??
    stringValue(record.description) ??
    stringValue(record.content);
  return [title, url, snippet].filter(Boolean).join('\n');
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function formatSearchHtml(html: string): string[] {
  const results: string[] = [];
  const resultLinkPattern =
    /<a\b[^>]*class=["'][^"']*result__a[^"']*["'][^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(resultLinkPattern)) {
    const href = decodeHtml(match[1] ?? '').trim();
    const title = stripHtml(match[2] ?? '').trim();
    if (href.length === 0 && title.length === 0) {
      continue;
    }
    results.push([title, normalizeDuckDuckGoLink(href)].filter(Boolean).join('\n'));
    if (results.length >= 10) {
      break;
    }
  }
  return results;
}

function stripHtml(html: string): string {
  return decodeHtml(html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' '));
}

function normalizeDuckDuckGoLink(href: string): string {
  try {
    const url = new URL(href, 'https://duckduckgo.com');
    const uddg = url.searchParams.get('uddg');
    return uddg ?? url.toString();
  } catch {
    return href;
  }
}

function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x2F;/g, '/')
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_match, decimal: string) =>
      String.fromCodePoint(Number.parseInt(decimal, 10)),
    );
}

export function toolInvocationSource(
  tool: Tool<JsonObject, unknown>,
  input: JsonObject,
): ToolInvocationSource | undefined {
  if (tool.mcp) {
    return { type: 'mcp', server: tool.mcp.server };
  }
  if (
    (tool.name === 'MCPTool' ||
      tool.name === 'ListMcpResourcesTool' ||
      tool.name === 'ReadMcpResourceTool') &&
    typeof input.server === 'string'
  ) {
    return { type: 'mcp', server: input.server };
  }
  if (tool.source === 'mcp') {
    return { type: 'mcp', server: tool.name };
  }
  if (tool.source === 'lsp') {
    return { type: 'lsp' };
  }
  return undefined;
}
