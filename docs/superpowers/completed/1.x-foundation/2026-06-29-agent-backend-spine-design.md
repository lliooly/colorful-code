# Agent Backend Spine — Tool Descriptor, Permission Policy, Session API

## Overview

This spec defines the three layers that turn the existing `@colorful-code/tool-runtime`
into a productizable agent backend:

1. **Tool descriptor** — the model-facing (and UI-facing) contract for a tool:
   name, description, input JSON Schema, disposition flags (read-only / destructive /
   concurrency-safe / enabled), and source (builtin / mcp / lsp). The model plans
   against descriptors; the runtime executes tool implementations. MCP tools must
   surface their real `inputSchema` as a descriptor, not a passthrough object.
2. **Permission policy** — a layered decision over every tool call: tool-owned risk
   plus a global policy that reasons about mode, workspace roots, network, and MCP
   trust, producing `allow | deny | ask` with a machine-readable reason for audit.
3. **Session API** — the product boundary. A session owns conversation, tool calls
   and results, cwd, permission state, MCP connections, todos/tasks, cancellation,
   and a resumable snapshot. The transport is an **event stream plus a bidirectional
   control channel** — not `POST /chat -> string`. Approval is a correlated
   request/response, not a fire-and-forget event.

These map closely to how mature coding agents are structured; the design is derived
from architectural patterns, not copied implementation. See the clean-room rule below.

## Clean-room constraint

Adapt patterns; do not copy leaked source, prompts, telemetry shapes, or product
naming. Use original identifiers. The display name is **Colorful Code**; avoid
`Claude Code` / `CLAUDE_CODE_*`. Keep prompt text original.

## Goals

- Make every tool serializable to a `ToolDescriptor` consumable by both the model API
  payload and the frontend.
- Convert MCP `inputSchema` into a real descriptor instead of `passthroughObjectSchema()`.
- Extend the permission decision from two-state (`allow|deny`) to three-state
  (`allow|deny|ask`) with a permission context (mode, workspace roots, rules, MCP trust)
  and an audit reason.
- Add a transport-agnostic `@colorful-code/session` package: session state, output
  event stream, bidirectional control channel, an injected model-client interface, and
  an in-process turn loop. Real LLM wiring and the NestJS HTTP/WS binding are follow-ups.
- Keep the no-extra-dependency posture: validation stays in the hand-rolled schema
  module; tests use `node:test` compiled via `tsconfig.test.json` (mirror tool-runtime).

## Non-Goals

- No real LLM/provider call in the session package (model client is an injected interface;
  tests use a mock).
- No NestJS HTTP/WS controllers yet (the session engine is transport-agnostic; binding is
  a thin follow-up against the interfaces defined here).
- No UI rendering layer. Descriptors carry data; rendering lives in the frontend.
- No frontend work (backend-first; the parked `apps/web/app/page.tsx` break stays parked).

## Build order (linear dependency)

```
Pillar 1 (descriptor) ──▶ Pillar 2 (permission) ──▶ Pillar 3 (session)
```

Pillar 2's `PermissionResult` is imported by Pillar 3's approval flow; Pillar 1's
descriptor + schema-to-JSON-Schema is imported by both. Implement in order; each pillar
commits before the next starts. Subagents own disjoint file sets (below) to keep the
chain clean.

---

## Pillar 1 — Tool descriptor + JSON Schema

### Files owned

- `packages/tool-runtime/src/core/schema.ts` (extend)
- `packages/tool-runtime/src/core/descriptor.ts` (new)
- `packages/tool-runtime/src/core/tool.ts` (extend `Tool`/`ToolDefinition`/`buildTool`)
- `packages/tool-runtime/src/mcp/adapter.ts` (use real `inputSchema`)
- `packages/tool-runtime/src/index.ts` (export descriptor)
- `packages/tool-runtime/src/__tests__/descriptor.test.ts` (new)

### Schema → JSON Schema

Each field parser also carries the JSON Schema fragment it validates, so an
`objectSchema` can emit a complete `ToolInputJSONSchema`. This is additive — existing
`.parse()` behaviour is unchanged.

```ts
export type JsonSchemaNode = { type?: string; [k: string]: unknown };

export type ToolInputJSONSchema = {
  type: 'object';
  properties?: Record<string, JsonSchemaNode>;
  required?: string[];
  additionalProperties?: boolean;
  [k: string]: unknown;
};

export type FieldParser<T> = {
  parse(value: unknown, key: string): T;
  readonly jsonSchema: JsonSchemaNode;   // fragment for this field
  readonly optional?: boolean;           // true => excluded from `required`
};

export type Schema<T> = {
  parse(input: unknown): T;
  readonly jsonSchema: ToolInputJSONSchema;
};
```

- `stringField/numberField/booleanField` accept an optional `{ description?: string }`
  and set `jsonSchema = { type: 'string'|'number'|'boolean', ...description }`.
- `arrayField(field)` → `jsonSchema = { type: 'array', items: field.jsonSchema }`.
- `objectField()` → `{ type: 'object' }`.
- `optionalField(field)` → wraps, sets `optional: true`, reuses `field.jsonSchema`.
- `objectSchema(shape)` → `jsonSchema = { type: 'object', properties, required, additionalProperties: false }`
  where `required` = keys whose field is not `optional`.
- `passthroughObjectSchema()` → `{ type: 'object', additionalProperties: true }`.

### Tool descriptor

Add to `Tool` / `ToolDefinition` (all optional on the definition so existing tools keep
compiling; `buildTool` fills defaults):

```ts
description?: string;          // static, model-facing capability description
searchHint?: string;           // short keyword phrase for tool search
inputJSONSchema?: ToolInputJSONSchema; // escape hatch; MCP sets this directly
source?: 'builtin' | 'mcp' | 'lsp';    // default 'builtin'
```

`ToolDescriptor` is the serializable contract:

```ts
export type ToolDescriptor = {
  name: string;
  aliases?: string[];
  description: string;
  searchHint?: string;
  inputSchema: ToolInputJSONSchema;   // from inputJSONSchema ?? schema.jsonSchema
  source: 'builtin' | 'mcp' | 'lsp';
  readOnly: boolean;
  destructive: boolean;
  concurrencySafe: boolean;
  enabled: boolean;
};

export function describeTool(tool: Tool): ToolDescriptor;
export function describeTools(tools: Tool[]): ToolDescriptor[];
```

`describeTool` resolves `inputSchema` from `tool.inputJSONSchema ?? tool.inputSchema.jsonSchema`,
and evaluates the disposition flags conservatively with an empty input
(`tool.isReadOnly({})`, etc.) — `Tool` is erased to `Tool<JsonObject>` at the registry
level, so `{}` typechecks. Document that descriptor flags are the **no-input
disposition**; the runner re-evaluates per call with real input.

### MCP adapter fix

In `createToolFromMcpMetadata`, stop using `passthroughObjectSchema()` as the contract.
Keep `passthroughObjectSchema()` for runtime `.parse()` (MCP servers own validation), but
set `inputJSONSchema` from `metadata.inputSchema` (when it is a `{ type: 'object', ... }`
object), set `description` from `metadata.description`, `searchHint` from the title, and
`source: 'mcp'`. Then `describeTool` emits the real MCP schema to the model.

### Tests

`createBuiltinTools()` all produce a descriptor with a non-empty `inputSchema.type === 'object'`;
`required` is computed correctly for a tool with mixed required/optional fields;
an MCP tool built from metadata with a real `inputSchema` surfaces that schema (not `{}`).

---

## Pillar 2 — Permission policy

### Files owned

- `packages/tool-runtime/src/core/permissions.ts` (new — owns all permission types)
- `packages/tool-runtime/src/core/tool.ts` (change `checkPermissions` return to `PermissionResult`)
- `packages/tool-runtime/src/core/runner.ts` (three-state flow + approval port + audit)
- `packages/tool-runtime/src/index.ts` (export permissions)
- `packages/tool-runtime/src/__tests__/permissions.test.ts` (new)

### Types (clean-room, original)

```ts
export type PermissionBehavior = 'allow' | 'deny' | 'ask';

export type PermissionMode =
  | 'default'      // ask for anything not pre-approved
  | 'plan'         // read-only; mutations denied
  | 'acceptEdits'  // auto-allow file edits inside workspace roots
  | 'readOnly'     // only read-only tools allowed
  | 'bypass';      // allow everything (explicit opt-in)

export type PermissionRuleSource =
  | 'userSettings' | 'projectSettings' | 'session' | 'cliArg' | 'policy';

export type PermissionRule = {
  source: PermissionRuleSource;
  behavior: PermissionBehavior;
  toolName: string;          // matches Tool.name or alias
  argPattern?: string;       // optional glob over a tool-defined permission string
};

export type McpTrustLevel = 'trusted' | 'ask' | 'blocked';

export type PermissionDecisionReason =
  | { type: 'rule'; rule: PermissionRule }
  | { type: 'mode'; mode: PermissionMode }
  | { type: 'toolDefault' }
  | { type: 'workspaceRoot'; reason: string }
  | { type: 'destructive'; reason: string }
  | { type: 'mcpTrust'; server: string; trust: McpTrustLevel }
  | { type: 'policy'; reason: string };

// Suggestions the UI can persist after an `ask` ("always allow Bash(git *)").
export type PermissionRuleUpdate = {
  destination: PermissionRuleSource;
  behavior: PermissionBehavior;
  toolName: string;
  argPattern?: string;
};

export type PermissionResult<Input extends JsonObject = JsonObject> =
  | { behavior: 'allow'; updatedInput?: Input; reason?: PermissionDecisionReason }
  | { behavior: 'ask'; message: string; updatedInput?: Input;
      suggestions?: PermissionRuleUpdate[]; reason?: PermissionDecisionReason }
  | { behavior: 'deny'; message: string; reason?: PermissionDecisionReason };

export type PermissionContext = {
  mode: PermissionMode;
  workspaceRoots: string[];
  rules: PermissionRule[];
  mcpTrust?: Map<string, McpTrustLevel>;
  allowNetwork?: boolean;
};

export type PermissionAuditEntry = {
  toolUseId: string;
  toolName: string;
  behavior: PermissionBehavior;
  reason?: PermissionDecisionReason;
  at: number;
};

// Approval port — provided by the session (Pillar 3). Headless => undefined.
export type ApprovalRequest = {
  toolUseId: string;
  toolName: string;
  input: JsonObject;
  message: string;
  suggestions?: PermissionRuleUpdate[];
};
export type ApprovalResponse =
  | { behavior: 'allow'; updatedInput?: JsonObject }
  | { behavior: 'deny'; message?: string };
export type RequestApproval = (req: ApprovalRequest) => Promise<ApprovalResponse>;

// A reusable default policy that evaluates context (mode, rules, roots, MCP trust,
// destructive, network) into a PermissionResult. Pure function, fully unit-testable.
export function evaluatePermission(
  tool: Tool, input: JsonObject, context: RuntimeContext,
): PermissionResult;
```

### `tool.ts` change

`Tool.checkPermissions` / `ToolDefinition.checkPermissions` return
`PermissionResult<Input>` instead of the old `PermissionDecision`. The `buildTool`
default returns `{ behavior: 'allow' }`. The old `PermissionDecision` alias is removed
(or re-exported from `permissions.ts` for compatibility). `RuntimeContext` gains:

```ts
permissionContext?: PermissionContext;
requestApproval?: RequestApproval;
permissionAudit?: PermissionAuditEntry[];
// permissionPolicy now returns PermissionResult (was allow|deny)
```

### Runner flow (`runner.ts`)

Replace the two-state block with: tool `checkPermissions` → global
`permissionContext` via `evaluatePermission` (if present) → caller `permissionPolicy`
(if present). Merge so the **most restrictive** wins (`deny` > `ask` > `allow`), carrying
`updatedInput`. Then:

- `deny` → error result, push audit, do not call.
- `ask` → if `context.requestApproval` exists, call it; map `allow`/`deny`. If absent
  (headless), treat as **deny** with a clear message. Push audit either way.
- `allow` → push audit, proceed.

Every decision appends a `PermissionAuditEntry` to `context.permissionAudit` (when set).

### Tests

`plan` mode denies a mutating tool and allows a read-only one;
`acceptEdits` auto-allows an Edit inside a workspace root but asks outside it;
a `session` allow-rule matching tool name short-circuits to allow;
an `ask` with no `requestApproval` becomes deny;
an `ask` with a `requestApproval` returning allow proceeds and records audit;
the most-restrictive merge (tool says allow, policy says deny → deny).

---

## Pillar 3 — Session API

### Packaging (revised): a `session/` module inside `@colorful-code/tool-runtime`

The spec originally called for a standalone `@colorful-code/session` package. The repo
has **no cross-package runtime-resolution story yet** — workspace packages resolve only
via root tsconfig `paths` for typecheck, nothing consumes another package's *built JS*,
and `tsc` does not rewrite import specifiers, so a standalone package's `node --test`
step would fail to resolve `@colorful-code/tool-runtime` at runtime without first
establishing a dist-based `exports`/symlink convention. That infra is orthogonal to this
design. So implement the session engine as a `session/` module **inside**
`@colorful-code/tool-runtime` using relative `.js` imports of descriptor/permissions/
runner, reusing the existing working test harness. It stays transport-agnostic and is
trivially extractable to `@colorful-code/session` once a built-output consumption
convention exists. No functional goal is lost.

### Files owned (all new, inside `packages/tool-runtime/src/`)

- `session/events.ts` — output event union
- `session/control.ts` — inbound control union + approval correlation
- `session/session.ts` — `Session` class
- `session/model.ts` — injected model-client interface + a mock for tests
- `session/turn.ts` — the in-process turn loop
- `session/index.ts` — re-exported from the package barrel `src/index.ts`
- `__tests__/session.test.ts`

### Output events (server → client)

```ts
export type SessionEvent =
  | { type: 'run_status'; status: 'running' | 'completed' | 'cancelled' | 'error'; runId: string }
  | { type: 'message_delta'; runId: string; text: string }                       // streaming assistant text
  | { type: 'message'; runId: string; role: 'assistant'; content: string }       // finalized message
  | { type: 'tool_call'; runId: string; toolUseId: string; name: string; input: JsonObject }
  | { type: 'tool_result'; runId: string; toolUseId: string; content: string; isError?: boolean }
  | { type: 'approval_required'; runId: string; requestId: string;               // correlated! awaits control response
      toolUseId: string; name: string; input: JsonObject; message: string;
      suggestions?: PermissionRuleUpdate[] }
  | { type: 'permission_decision'; runId: string; entry: PermissionAuditEntry }
  | { type: 'todos_updated'; runId: string; todos: TodoItem[] }
  | { type: 'error'; runId: string; message: string };
```

### Control messages (client → server) — bidirectional

```ts
export type ControlMessage =
  | { type: 'user_message'; text: string }
  | { type: 'approval_response'; requestId: string;                              // resolves the parked approval
      decision: { behavior: 'allow'; updatedInput?: JsonObject } | { behavior: 'deny'; message?: string } }
  | { type: 'cancel' }                                                           // aborts the current run
  | { type: 'set_permission_mode'; mode: PermissionMode };
```

### Session class

Owns:
- `id`, `cwd`
- `context: RuntimeContext` (reuses the existing runtime context — todos/tasks/teams/
  cron/mcp/skills/worktrees/signal already live there)
- `permissionContext: PermissionContext`
- conversation history: `Array<{ role; content; toolCalls?; toolResults? }>`
- `AbortController` for cancellation (sets `context.signal`)
- `registry: ToolRegistry`, `runner: ToolRunner`, `scheduler: ToolScheduler`
- a `ModelClient` (injected)
- an event emitter: `subscribe(listener: (e: SessionEvent) => void): () => void`
- a pending-approval map: `Map<requestId, (resp: ApprovalResponse) => void>`

API:
- `submit(text: string): Promise<void>` — appends a user message and runs a turn.
- `send(msg: ControlMessage): void` — routes control messages (user_message → submit,
  approval_response → resolve pending, cancel → abort, set_permission_mode → mutate context).
- `subscribe(listener)` — register an event listener; returns unsubscribe.
- `snapshot(): SessionSnapshot` / static `restore(snapshot, deps): Session` — resumable
  context (history + permission mode + todos/tasks). Serializable; no live handles.

The approval wiring is the key contract: the session sets
`context.requestApproval = (req) => new Promise((resolve) => { const requestId = ...;
this.pending.set(requestId, resolve-mapped); this.emit({ type:'approval_required', requestId, ... }); })`.
`send({ type:'approval_response', requestId, decision })` looks up and resolves it. A
`cancel` rejects/auto-denies all pending approvals.

### Model client interface (injected; mock in tests)

```ts
export type ModelTurnInput = {
  history: ConversationEntry[];
  tools: ToolDescriptor[];     // descriptors from Pillar 1
  signal: AbortSignal;
};
export type ModelTurnEvent =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; toolUseId: string; name: string; input: JsonObject }
  | { type: 'end' };
export interface ModelClient {
  run(input: ModelTurnInput): AsyncIterable<ModelTurnEvent>;
}
```

### Turn loop (`turn.ts`)

Given a session + a finalized user message: emit `run_status: running`; build
`ToolDescriptor[]` from the registry; call `model.run(...)`; for each model event:
`text` → `message_delta`; `tool_use` → emit `tool_call`, run via `ToolRunner` (which
hits the Pillar 2 permission flow → may emit `approval_required` and await), emit
`tool_result`, feed the result back into history and continue the loop until `end` with
no pending tool calls; then `run_status: completed`. Cancellation via `AbortController`
→ `run_status: cancelled`. Errors → `error` + `run_status: error`.

### Tests (with a mock ModelClient)

A scripted model that emits text then a `tool_use` for a read-only built-in tool drives a
full turn: assert the event order (`running` → `message_delta` → `tool_call` →
`tool_result` → `completed`) and that the tool actually ran via the registry.
An `ask` tool with the session's approval wiring emits `approval_required`, parks, and
completes after `send({ type:'approval_response', behavior:'allow' })`.
`send({ type:'cancel' })` mid-run emits `run_status: cancelled` and auto-denies pending
approvals. `snapshot()` then `restore()` preserves history and permission mode.

---

## Verification (all pillars)

From repo root, each pillar must pass before the next starts:

```
pnpm --filter @colorful-code/tool-runtime typecheck
pnpm --filter @colorful-code/tool-runtime test
pnpm --filter @colorful-code/tool-runtime lint
# Pillar 3 also:
pnpm --filter @colorful-code/session typecheck
pnpm --filter @colorful-code/session test
pnpm --filter @colorful-code/session lint
```

Existing tool-runtime tests must keep passing (the descriptor and permission changes are
additive / type-compatible). Do not touch `apps/web` (parked build break). Keep the
clean-room rule: original naming, no copied source/prompts/telemetry.
