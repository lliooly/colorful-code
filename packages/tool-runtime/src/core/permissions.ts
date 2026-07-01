import { isAbsolute, relative, resolve } from 'node:path';
import type {
  JsonObject,
  RuntimeContext,
  Tool,
  ToolInvocationSource,
} from './tool.js';

// The three-state permission verdict. `deny` blocks the call outright; `ask`
// defers to the session's approval port; `allow` proceeds. Ordering for the
// most-restrictive merge is `deny` > `ask` > `allow`.
export type PermissionBehavior = 'allow' | 'deny' | 'ask';

export type PermissionMode =
  | 'default' // ask for anything not pre-approved
  | 'plan' // read-only; mutations denied
  | 'acceptEdits' // auto-allow file edits inside workspace roots
  | 'workspaceWrite' // writes must stay inside workspace roots
  | 'readOnly' // only read-only tools allowed
  | 'bypass'; // allow everything (explicit opt-in)

export type PermissionRuleSource =
  | 'userSettings'
  | 'projectSettings'
  | 'session'
  | 'cliArg'
  | 'policy';

export type PermissionRule = {
  source: PermissionRuleSource;
  behavior: PermissionBehavior;
  toolName: string; // matches Tool.name or alias
  argPattern?: string; // optional glob over a tool-defined permission string
};

export type McpTrustLevel = 'trusted' | 'ask' | 'blocked';

export type PermissionDecisionReason =
  | { type: 'rule'; rule: PermissionRule }
  | { type: 'mode'; mode: PermissionMode }
  | { type: 'toolDefault' }
  | { type: 'workspaceRoot'; reason: string }
  | { type: 'destructive'; reason: string }
  | { type: 'mcpTrust'; server: string; trust: McpTrustLevel }
  | { type: 'hook'; hookId?: string; reason: string }
  | { type: 'policy'; reason: string };

export type BashCommandClassification = {
  command: string;
  segments: string[];
  firstCommand: string;
  isReadOnly: boolean;
  isDestructive: boolean;
  hasPipe: boolean;
  hasRedirect: boolean;
  hasEnvAssignment: boolean;
  hasBackgroundOperator: boolean;
  hasCommandSubstitution: boolean;
  hasCommandSeparator: boolean;
  hasComplexShellSyntax: boolean;
  destructiveReason?: string;
};

export type NetworkTarget = {
  provider: string;
  url?: string;
  host?: string;
  scheme?: string;
};

export type NetworkProviderBehavior = 'allow' | 'ask' | 'deny';

// Suggestions the UI can persist after an `ask` ("always allow Bash(git *)").
export type PermissionRuleUpdate = {
  destination: PermissionRuleSource;
  behavior: PermissionBehavior;
  toolName: string;
  argPattern?: string;
};

export type PermissionResult<Input extends JsonObject = JsonObject> =
  | {
      behavior: 'allow';
      updatedInput?: Input;
      reason?: PermissionDecisionReason;
    }
  | {
      behavior: 'ask';
      message: string;
      updatedInput?: Input;
      suggestions?: PermissionRuleUpdate[];
      reason?: PermissionDecisionReason;
    }
  | { behavior: 'deny'; message: string; reason?: PermissionDecisionReason };

export type PermissionContext = {
  mode: PermissionMode;
  workspaceRoots: string[];
  rules: PermissionRule[];
  mcpTrust?: Map<string, McpTrustLevel>;
  allowNetwork?: boolean;
  restrictReadToWorkspace?: boolean;
  hostAllowlist?: string[];
  networkProviders?: Record<string, NetworkProviderBehavior>;
};

export type PermissionAuditEntry = {
  toolUseId: string;
  toolName: string;
  behavior: PermissionBehavior;
  reason?: PermissionDecisionReason;
  resolvedPath?: string;
  commandClassification?: BashCommandClassification;
  networkTarget?: NetworkTarget;
  at: number;
};

// Approval port — provided by the session (Pillar 3). Headless => undefined.
export type ApprovalRequest = {
  toolUseId: string;
  toolName: string;
  input: JsonObject;
  message: string;
  source?: ToolInvocationSource;
  suggestions?: PermissionRuleUpdate[];
};
export type ApprovalResponse =
  | { behavior: 'allow'; updatedInput?: JsonObject }
  | { behavior: 'deny'; message?: string };
export type RequestApproval = (
  req: ApprovalRequest,
) => Promise<ApprovalResponse>;

// Ranks behaviours for the most-restrictive merge: deny (2) > ask (1) > allow (0).
const BEHAVIOR_RANK: Record<PermissionBehavior, number> = {
  allow: 0,
  ask: 1,
  deny: 2,
};

export function isMoreRestrictive(
  candidate: PermissionBehavior,
  current: PermissionBehavior,
): boolean {
  return BEHAVIOR_RANK[candidate] > BEHAVIOR_RANK[current];
}

// Returns true when `toolName` (a rule target) names this tool by its primary
// name or one of its aliases.
function ruleMatchesTool(rule: PermissionRule, tool: Tool): boolean {
  if (rule.toolName === tool.name) {
    return true;
  }
  return (tool.aliases ?? []).includes(rule.toolName);
}

// Very small glob matcher (`*` => any run of characters). `argPattern` is matched
// against the tool's permission string; tools without one only match rules that
// omit `argPattern`. Kept deliberately simple and documented rather than pulling
// in a glob dependency.
function globMatches(pattern: string, value: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  const expression = '^' + escaped.replace(/\*/g, '.*') + '$';
  return new RegExp(expression).test(value);
}

// A tool may expose a permission string the rules glob against. We look for a
// conventional `path` or `command` field on the input; absent that there is no
// arg string to match and `argPattern` rules will not apply.
export function permissionString(input: JsonObject): string | undefined {
  for (const key of ['command', 'path', 'url']) {
    const value = input[key];
    if (typeof value === 'string') {
      return value;
    }
  }
  return undefined;
}

function findMatchingRule(
  rules: PermissionRule[],
  tool: Tool,
  input: JsonObject,
): PermissionRule | undefined {
  const arg = permissionString(input);
  return rules.find((rule) => {
    if (!ruleMatchesTool(rule, tool)) {
      return false;
    }
    if (rule.argPattern === undefined) {
      return true;
    }
    return arg !== undefined && globMatches(rule.argPattern, arg);
  });
}

// Recovers the MCP server name from a tool whose `source` is `mcp`. MCP tool
// names are `mcp__<server>__<tool>`; the server segment is everything between
// the leading `mcp__` and the next `__`.
function mcpServerName(tool: Tool): string | undefined {
  if (tool.source !== 'mcp') {
    return undefined;
  }
  const withoutPrefix = tool.name.startsWith('mcp__')
    ? tool.name.slice('mcp__'.length)
    : tool.name;
  const separator = withoutPrefix.indexOf('__');
  return separator === -1 ? withoutPrefix : withoutPrefix.slice(0, separator);
}

// Treats a tool as a file edit when it is not read-only and its input names a
// `path`. This is intentionally a heuristic (the runtime has no formal "edits a
// file" capability flag); it covers the built-in Edit/Write tools and any tool
// that follows the same `path` convention.
function isFileEdit(tool: Tool, input: JsonObject): boolean {
  return !tool.isReadOnly(input) && typeof input.path === 'string';
}

function isFileRead(tool: Tool, input: JsonObject): boolean {
  return tool.isReadOnly(input) && typeof input.path === 'string';
}

export function resolvePathForPermission(
  input: JsonObject,
  cwd: string | undefined,
): string | undefined {
  const rawPath = input.path;
  if (typeof rawPath !== 'string') {
    return undefined;
  }
  return resolve(cwd ?? process.cwd(), rawPath);
}

export function normalizeWorkspaceRoots(
  roots: string[],
  cwd: string | undefined,
): string[] {
  const base = cwd ?? process.cwd();
  return roots.map((root) => resolve(base, root));
}

export function isPathInsideWorkspaceRoots(
  absolutePath: string,
  roots: string[],
  cwd: string | undefined,
): boolean {
  const absoluteRoots = normalizeWorkspaceRoots(roots, cwd);
  return absoluteRoots.some((root) => {
    const rel = relative(root, absolutePath);
    return rel === '' || (!!rel && !rel.startsWith('..') && !isAbsolute(rel));
  });
}

// Returns true when the resolved file path lives inside one of the workspace
// roots. Roots and the path are both resolved to absolute form first so that
// relative roots, `..` segments, and trailing slashes compare consistently.
function isInsideWorkspaceRoots(
  input: JsonObject,
  roots: string[],
  cwd: string | undefined,
): boolean {
  const absolutePath = resolvePathForPermission(input, cwd);
  return (
    absolutePath !== undefined &&
    isPathInsideWorkspaceRoots(absolutePath, roots, cwd)
  );
}

// Pure, fully unit-testable default policy. Reads `context.permissionContext`
// (mode, workspace roots, rules, MCP trust, network) and the tool's disposition
// to produce a three-state `PermissionResult` with a machine-readable reason.
// Layering inside this function (first match wins):
//   1. `bypass` mode allows everything.
//   2. `plan` / `readOnly` mode allows read-only tools and denies mutations.
//   3. an explicit matching rule returns its behaviour.
//   4. `acceptEdits` mode auto-allows file edits inside a workspace root and
//      asks for edits outside the roots.
//   5. an MCP tool consults its server trust level.
//   6. otherwise the `default` policy: read-only tools allow, destructive tools
//      ask, everything else allows.
export function evaluatePermission(
  tool: Tool<JsonObject, unknown>,
  input: JsonObject,
  context: RuntimeContext,
): PermissionResult {
  const permissionContext = context.permissionContext;
  // No permission context means there is nothing to evaluate against; default to
  // allow so the runner falls through to the tool's own decision.
  if (!permissionContext) {
    return { behavior: 'allow', reason: { type: 'toolDefault' } };
  }

  const { mode } = permissionContext;
  const readOnly = tool.isReadOnly(input);

  // 1. Explicit bypass.
  if (mode === 'bypass') {
    return { behavior: 'allow', reason: { type: 'mode', mode: 'bypass' } };
  }

  // 2. Plan / read-only modes: mutations are not permitted.
  if (mode === 'plan' || mode === 'readOnly') {
    if (readOnly) {
      return { behavior: 'allow', reason: { type: 'mode', mode } };
    }
    return {
      behavior: 'deny',
      message:
        "Tool '" +
        tool.name +
        "' mutates state and is not allowed in '" +
        mode +
        "' mode.",
      reason: { type: 'mode', mode },
    };
  }

  if (tool.name === 'Bash' && tool.isDestructive(input)) {
    return {
      behavior: 'ask',
      message: "Tool '" + tool.name + "' is destructive and requires approval.",
      reason: {
        type: 'destructive',
        reason: 'Destructive Bash commands always require approval.',
      },
    };
  }

  if (mode === 'workspaceWrite' && isFileEdit(tool, input)) {
    if (
      isInsideWorkspaceRoots(
        input,
        permissionContext.workspaceRoots,
        context.cwd,
      )
    ) {
      return {
        behavior: 'allow',
        reason: {
          type: 'workspaceRoot',
          reason: 'Write inside a workspace root is allowed in workspaceWrite mode.',
        },
      };
    }
    return {
      behavior: 'deny',
      message: 'Write targets a path outside the workspace roots.',
      reason: {
        type: 'workspaceRoot',
        reason: 'workspaceWrite mode forbids writes outside workspace roots.',
      },
    };
  }

  if (
    permissionContext.restrictReadToWorkspace === true &&
    isFileRead(tool, input) &&
    !isInsideWorkspaceRoots(input, permissionContext.workspaceRoots, context.cwd)
  ) {
    return {
      behavior: 'deny',
      message: 'Read targets a path outside the workspace roots.',
      reason: {
        type: 'workspaceRoot',
        reason: 'Reads outside workspace roots are disabled by policy.',
      },
    };
  }

  // 3. Explicit rule match short-circuits to the rule's behaviour.
  const rule = findMatchingRule(permissionContext.rules, tool, input);
  if (rule) {
    if (rule.behavior === 'allow') {
      return { behavior: 'allow', reason: { type: 'rule', rule } };
    }
    if (rule.behavior === 'deny') {
      return {
        behavior: 'deny',
        message: "Tool '" + tool.name + "' is denied by a permission rule.",
        reason: { type: 'rule', rule },
      };
    }
    return {
      behavior: 'ask',
      message:
        "Tool '" + tool.name + "' requires approval per a permission rule.",
      reason: { type: 'rule', rule },
    };
  }

  // 4. acceptEdits: auto-allow file edits inside a workspace root, ask outside.
  if (mode === 'acceptEdits' && isFileEdit(tool, input)) {
    if (
      isInsideWorkspaceRoots(
        input,
        permissionContext.workspaceRoots,
        context.cwd,
      )
    ) {
      return {
        behavior: 'allow',
        reason: {
          type: 'workspaceRoot',
          reason:
            'Edit inside a workspace root is auto-approved in acceptEdits mode.',
        },
      };
    }
    return {
      behavior: 'ask',
      message:
        'Edit targets a path outside the workspace roots; approval required.',
      reason: {
        type: 'workspaceRoot',
        reason: 'Edit outside the workspace roots requires approval.',
      },
    };
  }

  // 5. MCP tools consult their server trust level.
  const server = mcpServerName(tool);
  if (server) {
    const trust = permissionContext.mcpTrust?.get(server) ?? 'ask';
    if (trust === 'trusted') {
      return {
        behavior: 'allow',
        reason: { type: 'mcpTrust', server, trust },
      };
    }
    if (trust === 'blocked') {
      return {
        behavior: 'deny',
        message: "MCP server '" + server + "' is blocked.",
        reason: { type: 'mcpTrust', server, trust },
      };
    }
    return {
      behavior: 'ask',
      message: "MCP server '" + server + "' requires approval for tool calls.",
      reason: { type: 'mcpTrust', server, trust },
    };
  }

  // 6. default mode: read-only allows, destructive asks, the rest allows.
  if (readOnly) {
    return { behavior: 'allow', reason: { type: 'toolDefault' } };
  }
  if (tool.isDestructive(input)) {
    return {
      behavior: 'ask',
      message: "Tool '" + tool.name + "' is destructive and requires approval.",
      reason: {
        type: 'destructive',
        reason: 'Destructive tools require approval in default mode.',
      },
    };
  }
  return { behavior: 'allow', reason: { type: 'toolDefault' } };
}
