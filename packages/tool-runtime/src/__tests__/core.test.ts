import test from "node:test";
import assert from "node:assert/strict";
import {
  ToolRegistry,
  ToolRunner,
  buildTool,
  objectSchema,
  stringField,
  type ToolResultBlock,
} from "../index.js";

test("buildTool supplies conservative defaults", async () => {
  const tool = buildTool({
    name: "Echo",
    inputSchema: objectSchema({ text: stringField() }),
    async call(input) {
      return { data: input.text };
    },
    mapResult(data, toolUseId): ToolResultBlock {
      return { toolUseId, content: data };
    },
  });

  assert.equal(tool.isEnabled(), true);
  assert.equal(tool.isReadOnly({ text: "hello" }), false);
  assert.equal(tool.isConcurrencySafe({ text: "hello" }), false);
  assert.equal(tool.isDestructive({ text: "hello" }), false);
  assert.deepEqual(await tool.checkPermissions({ text: "hello" }, {}), {
    behavior: "allow",
  });
});

test("ToolRegistry resolves aliases and rejects duplicate names", () => {
  const alpha = buildTool({
    name: "Alpha",
    aliases: ["A"],
    inputSchema: objectSchema({}),
    async call() {
      return { data: "ok" };
    },
    mapResult(data, toolUseId) {
      return { toolUseId, content: data };
    },
  });

  const registry = new ToolRegistry([alpha]);
  assert.equal(registry.get("A"), alpha);
  assert.throws(() => new ToolRegistry([alpha, alpha]), /Duplicate tool name/);
});

test("ToolRunner returns an error result when permission denies a tool", async () => {
  let called = false;
  const tool = buildTool({
    name: "Secret",
    inputSchema: objectSchema({ text: stringField() }),
    async checkPermissions() {
      return { behavior: "deny", message: "blocked" };
    },
    async call() {
      called = true;
      return { data: "should not run" };
    },
    mapResult(data, toolUseId) {
      return { toolUseId, content: data };
    },
  });

  const runner = new ToolRunner(new ToolRegistry([tool]));
  const result = await runner.run({ id: "t1", name: "Secret", input: { text: "x" } });

  assert.equal(called, false);
  assert.equal(result.isError, true);
  assert.match(result.content, /blocked/);
});

test("ToolRunner validates input and maps successful results", async () => {
  const tool = buildTool({
    name: "Echo",
    inputSchema: objectSchema({ text: stringField() }),
    async call(input) {
      return { data: input.text.toUpperCase() };
    },
    mapResult(data, toolUseId) {
      return { toolUseId, content: data };
    },
  });

  const runner = new ToolRunner(new ToolRegistry([tool]));
  const ok = await runner.run({ id: "t2", name: "Echo", input: { text: "hi" } });
  assert.deepEqual(ok, { toolUseId: "t2", content: "HI" });

  const bad = await runner.run({ id: "t3", name: "Echo", input: { text: 42 } });
  assert.equal(bad.isError, true);
  assert.match(bad.content, /Invalid input/);
});
