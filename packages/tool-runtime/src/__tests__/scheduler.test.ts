import test from "node:test";
import assert from "node:assert/strict";
import {
  ToolRegistry,
  ToolRunner,
  ToolScheduler,
  buildTool,
  objectSchema,
} from "../index.js";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("ToolScheduler runs neighboring concurrency-safe tools together", async () => {
  const readTool = buildTool({
    name: "ReadLike",
    inputSchema: objectSchema({}),
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    async call() {
      await delay(70);
      return { data: "done" };
    },
    mapResult(data, toolUseId) {
      return { toolUseId, content: data };
    },
  });

  const scheduler = new ToolScheduler(new ToolRunner(new ToolRegistry([readTool])));
  const started = Date.now();
  const results = await scheduler.runAll([
    { id: "a", name: "ReadLike", input: {} },
    { id: "b", name: "ReadLike", input: {} },
  ]);

  assert.deepEqual(results.map((result) => result.toolUseId), ["a", "b"]);
  assert.ok(Date.now() - started < 125, "expected both reads to overlap");
});

test("ToolScheduler runs mutating tools serially", async () => {
  const events: string[] = [];
  const writeTool = buildTool({
    name: "WriteLike",
    inputSchema: objectSchema({}),
    async call(_input, context) {
      events.push("start:" + context.toolUseId);
      await delay(20);
      events.push("end:" + context.toolUseId);
      return { data: "done" };
    },
    mapResult(data, toolUseId) {
      return { toolUseId, content: data };
    },
  });

  const scheduler = new ToolScheduler(new ToolRunner(new ToolRegistry([writeTool])));
  await scheduler.runAll([
    { id: "a", name: "WriteLike", input: {} },
    { id: "b", name: "WriteLike", input: {} },
  ]);

  assert.deepEqual(events, ["start:a", "end:a", "start:b", "end:b"]);
});
