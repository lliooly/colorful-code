import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ToolRegistry,
  ToolRunner,
  buildTool,
  createRuntimeContext,
  evaluatePermission,
  objectSchema,
  stringField,
  type ApprovalRequest,
  type ApprovalResponse,
  type PermissionAuditEntry,
  type PermissionContext,
  type RuntimeContext,
  type Tool,
} from "../index.js";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "colorful-permissions-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// A read-only no-op tool used to exercise the read-only branches.
function readOnlyTool(name = "Peek"): Tool {
  return buildTool({
    name,
    inputSchema: objectSchema({}),
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    async call() {
      return { data: "ok" };
    },
    mapResult(data, toolUseId) {
      return { toolUseId, content: data };
    },
  });
}

// A mutating tool (not read-only) used to exercise the mutation branches.
function mutatingTool(name = "Mutate"): Tool {
  return buildTool({
    name,
    inputSchema: objectSchema({ value: stringField() }),
    isDestructive: () => true,
    async call(input) {
      return { data: String(input.value) };
    },
    mapResult(data, toolUseId) {
      return { toolUseId, content: data };
    },
  });
}

test("evaluatePermission: plan mode denies a mutating tool and allows a read-only one", () => {
  const permissionContext: PermissionContext = {
    mode: "plan",
    workspaceRoots: [],
    rules: [],
  };
  const context: RuntimeContext = createRuntimeContext({ permissionContext });

  const denied = evaluatePermission(mutatingTool(), { value: "x" }, context);
  assert.equal(denied.behavior, "deny");
  assert.deepEqual(denied.reason, { type: "mode", mode: "plan" });

  const allowed = evaluatePermission(readOnlyTool(), {}, context);
  assert.equal(allowed.behavior, "allow");
  assert.deepEqual(allowed.reason, { type: "mode", mode: "plan" });
});

test("evaluatePermission: acceptEdits allows an Edit inside a workspace root but asks outside it", async () => {
  await withTempDir(async (dir) => {
    const inside = join(dir, "src", "file.ts");
    const outside = join(tmpdir(), "colorful-outside-root.ts");
    const editTool = mutatingTool("Edit");

    const permissionContext: PermissionContext = {
      mode: "acceptEdits",
      workspaceRoots: [dir],
      rules: [],
    };
    const context: RuntimeContext = createRuntimeContext({ permissionContext });

    const insideResult = evaluatePermission(editTool, { path: inside, value: "x" }, context);
    assert.equal(insideResult.behavior, "allow");
    assert.equal(insideResult.reason?.type, "workspaceRoot");

    const outsideResult = evaluatePermission(editTool, { path: outside, value: "x" }, context);
    assert.equal(outsideResult.behavior, "ask");
    assert.equal(outsideResult.reason?.type, "workspaceRoot");
  });
});

test("evaluatePermission: a matching rule short-circuits to its behavior", () => {
  const tool = mutatingTool("Mutate");
  const permissionContext: PermissionContext = {
    mode: "default",
    workspaceRoots: [],
    rules: [
      { source: "session", behavior: "allow", toolName: "Mutate" },
    ],
  };
  const context: RuntimeContext = createRuntimeContext({ permissionContext });

  const result = evaluatePermission(tool, { value: "x" }, context);
  assert.equal(result.behavior, "allow");
  assert.equal(result.reason?.type, "rule");
});

test("evaluatePermission: MCP trust drives allow/deny/ask", () => {
  const mcpTool = buildTool({
    name: "mcp__docs__search",
    source: "mcp",
    inputSchema: objectSchema({}),
    async call() {
      return { data: "ok" };
    },
    mapResult(data, toolUseId) {
      return { toolUseId, content: data };
    },
  });

  const base: PermissionContext = {
    mode: "default",
    workspaceRoots: [],
    rules: [],
  };

  const trusted = evaluatePermission(
    mcpTool,
    {},
    createRuntimeContext({
      permissionContext: { ...base, mcpTrust: new Map([["docs", "trusted"]]) },
    }),
  );
  assert.equal(trusted.behavior, "allow");

  const blocked = evaluatePermission(
    mcpTool,
    {},
    createRuntimeContext({
      permissionContext: { ...base, mcpTrust: new Map([["docs", "blocked"]]) },
    }),
  );
  assert.equal(blocked.behavior, "deny");

  const unset = evaluatePermission(
    mcpTool,
    {},
    createRuntimeContext({ permissionContext: base }),
  );
  assert.equal(unset.behavior, "ask");
});

test("ToolRunner: a session allow-rule short-circuits a destructive tool to allow", async () => {
  await withTempDir(async (dir) => {
    const target = join(dir, "note.txt");
    const audit: PermissionAuditEntry[] = [];
    const context = createRuntimeContext({
      cwd: dir,
      permissionContext: {
        mode: "default",
        workspaceRoots: [dir],
        rules: [{ source: "session", behavior: "allow", toolName: "Write" }],
      },
      permissionAudit: audit,
    });
    const { createBuiltinTools } = await import("../index.js");
    const runner = new ToolRunner(new ToolRegistry(createBuiltinTools()), context);

    const result = await runner.run({
      id: "w1",
      name: "Write",
      input: { path: target, content: "hello" },
    });

    assert.equal(result.isError, undefined);
    assert.equal(audit.at(-1)?.behavior, "allow");
    assert.deepEqual(audit.at(-1)?.reason, {
      type: "rule",
      rule: { source: "session", behavior: "allow", toolName: "Write" },
    });
  });
});

test("ToolRunner: an ask with no requestApproval becomes deny and records audit", async () => {
  let called = false;
  const asking = buildTool({
    name: "Touchy",
    inputSchema: objectSchema({ value: stringField() }),
    isDestructive: () => true,
    async checkPermissions() {
      return { behavior: "ask", message: "please confirm" };
    },
    async call() {
      called = true;
      return { data: "ran" };
    },
    mapResult(data, toolUseId) {
      return { toolUseId, content: data };
    },
  });

  const audit: PermissionAuditEntry[] = [];
  const context = createRuntimeContext({ permissionAudit: audit });
  const runner = new ToolRunner(new ToolRegistry([asking]), context);

  const result = await runner.run({ id: "t1", name: "Touchy", input: { value: "x" } });

  assert.equal(called, false);
  assert.equal(result.isError, true);
  assert.match(result.content, /no approval handler/i);
  assert.equal(audit.at(-1)?.behavior, "deny");
});

test("ToolRunner: an ask with a requestApproval returning allow proceeds and records an audit entry", async () => {
  const requests: ApprovalRequest[] = [];
  const requestApproval = async (req: ApprovalRequest): Promise<ApprovalResponse> => {
    requests.push(req);
    return { behavior: "allow" };
  };

  let called = false;
  const asking = buildTool({
    name: "Touchy",
    inputSchema: objectSchema({ value: stringField() }),
    isDestructive: () => true,
    async checkPermissions() {
      return { behavior: "ask", message: "please confirm" };
    },
    async call(input) {
      called = true;
      return { data: String(input.value) };
    },
    mapResult(data, toolUseId) {
      return { toolUseId, content: data };
    },
  });

  const audit: PermissionAuditEntry[] = [];
  const context = createRuntimeContext({ requestApproval, permissionAudit: audit });
  const runner = new ToolRunner(new ToolRegistry([asking]), context);

  const result = await runner.run({ id: "t1", name: "Touchy", input: { value: "go" } });

  assert.equal(called, true);
  assert.equal(result.isError, undefined);
  assert.equal(result.content, "go");
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.toolName, "Touchy");
  assert.equal(audit.at(-1)?.behavior, "allow");
});

test("ToolRunner: a valid approval updatedInput is applied to the tool call", async () => {
  let received: string | undefined;
  const asking = buildTool({
    name: "Touchy",
    inputSchema: objectSchema({ value: stringField() }),
    isDestructive: () => true,
    async checkPermissions() {
      return { behavior: "ask", message: "please confirm" };
    },
    async call(input) {
      received = input.value;
      return { data: input.value };
    },
    mapResult(data, toolUseId) {
      return { toolUseId, content: data };
    },
  });

  const requestApproval = async (): Promise<ApprovalResponse> => ({
    behavior: "allow",
    updatedInput: { value: "rewritten" },
  });
  const context = createRuntimeContext({ requestApproval });
  const runner = new ToolRunner(new ToolRegistry([asking]), context);

  const result = await runner.run({ id: "t1", name: "Touchy", input: { value: "original" } });

  assert.equal(result.isError, undefined);
  assert.equal(received, "rewritten");
  assert.equal(result.content, "rewritten");
});

test("ToolRunner: a schema-invalid approval updatedInput is rejected before tool.call", async () => {
  let called = false;
  const asking = buildTool({
    name: "Touchy",
    inputSchema: objectSchema({ value: stringField() }),
    isDestructive: () => true,
    async checkPermissions() {
      return { behavior: "ask", message: "please confirm" };
    },
    async call() {
      called = true;
      return { data: "ran" };
    },
    mapResult(data, toolUseId) {
      return { toolUseId, content: data };
    },
  });

  // The approval rewrites the input to an object-shaped but schema-invalid value
  // (`value` must be a string). The runner must re-validate and reject it before
  // the tool runs — object-shape alone is not enough.
  const requestApproval = async (): Promise<ApprovalResponse> => ({
    behavior: "allow",
    updatedInput: { value: 123 } as unknown as Record<string, unknown>,
  });
  const audit: PermissionAuditEntry[] = [];
  const context = createRuntimeContext({ requestApproval, permissionAudit: audit });
  const runner = new ToolRunner(new ToolRegistry([asking]), context);

  const result = await runner.run({ id: "t1", name: "Touchy", input: { value: "ok" } });

  assert.equal(called, false, "tool must not run with malformed updated input");
  assert.equal(result.isError, true);
  assert.match(result.content, /must be a string/);
});

test("ToolRunner: most-restrictive merge — tool allow + policy deny -> deny", async () => {
  let called = false;
  const tool = buildTool({
    name: "Open",
    inputSchema: objectSchema({ value: stringField() }),
    async checkPermissions() {
      return { behavior: "allow" };
    },
    async call() {
      called = true;
      return { data: "ran" };
    },
    mapResult(data, toolUseId) {
      return { toolUseId, content: data };
    },
  });

  const audit: PermissionAuditEntry[] = [];
  const context = createRuntimeContext({
    permissionAudit: audit,
    permissionPolicy: () => ({ behavior: "deny", message: "policy says no" }),
  });
  const runner = new ToolRunner(new ToolRegistry([tool]), context);

  const result = await runner.run({ id: "t1", name: "Open", input: { value: "x" } });

  assert.equal(called, false);
  assert.equal(result.isError, true);
  assert.match(result.content, /policy says no/);
  assert.equal(audit.at(-1)?.behavior, "deny");
});

test("ToolRunner: most-restrictive merge — policy ask + context deny -> deny", async () => {
  // Tool allows, caller policy asks, but the permission context denies (plan mode
  // on a mutating tool). The strongest verdict (deny) must win.
  let called = false;
  const tool = buildTool({
    name: "Mutate",
    inputSchema: objectSchema({ value: stringField() }),
    isDestructive: () => true,
    async call() {
      called = true;
      return { data: "ran" };
    },
    mapResult(data, toolUseId) {
      return { toolUseId, content: data };
    },
  });

  const audit: PermissionAuditEntry[] = [];
  const context = createRuntimeContext({
    permissionContext: { mode: "plan", workspaceRoots: [], rules: [] },
    permissionAudit: audit,
    permissionPolicy: () => ({ behavior: "ask", message: "policy asks" }),
    requestApproval: async () => ({ behavior: "allow" }),
  });
  const runner = new ToolRunner(new ToolRegistry([tool]), context);

  const result = await runner.run({ id: "t1", name: "Mutate", input: { value: "x" } });

  assert.equal(called, false);
  assert.equal(result.isError, true);
  assert.equal(audit.at(-1)?.behavior, "deny");
});

test("ToolRunner: bypass mode allows everything regardless of disposition", async () => {
  await withTempDir(async (dir) => {
    const target = join(dir, "out.txt");
    await writeFile(target, "seed", "utf8");
    const audit: PermissionAuditEntry[] = [];
    const context = createRuntimeContext({
      cwd: dir,
      permissionContext: { mode: "bypass", workspaceRoots: [], rules: [] },
      permissionAudit: audit,
    });
    const { createBuiltinTools } = await import("../index.js");
    const runner = new ToolRunner(new ToolRegistry(createBuiltinTools()), context);

    const result = await runner.run({
      id: "w1",
      name: "Write",
      input: { path: target, content: "replaced" },
    });

    assert.equal(result.isError, undefined);
    assert.equal(audit.at(-1)?.behavior, "allow");
    assert.deepEqual(audit.at(-1)?.reason, { type: "mode", mode: "bypass" });
  });
});
