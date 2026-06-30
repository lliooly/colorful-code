import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ToolRegistry,
  ToolRunner,
  createBuiltinTools,
  createRuntimeContext,
} from "../index.js";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "colorful-tool-runtime-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("Edit requires a prior complete Read", async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, "note.txt");
    await writeFile(file, "hello", "utf8");
    const runner = new ToolRunner(new ToolRegistry(createBuiltinTools()), createRuntimeContext());

    const result = await runner.run({
      id: "edit-1",
      name: "Edit",
      input: { path: file, oldText: "hello", newText: "hi" },
    });

    assert.equal(result.isError, true);
    assert.match(result.content, /read before editing/i);
  });
});

test("Read then Edit updates an exact match", async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, "note.txt");
    await writeFile(file, "hello world", "utf8");
    const context = createRuntimeContext();
    const runner = new ToolRunner(new ToolRegistry(createBuiltinTools()), context);

    await runner.run({ id: "read-1", name: "Read", input: { path: file } });
    const edit = await runner.run({
      id: "edit-1",
      name: "Edit",
      input: { path: file, oldText: "hello", newText: "hi" },
    });

    assert.equal(edit.isError, undefined);
    assert.equal(await readFile(file, "utf8"), "hi world");
  });
});

test("Read returns numbered pages using one-based offset and limit", async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, "note.txt");
    await writeFile(file, "alpha\nbeta\ngamma\ndelta\n", "utf8");
    const runner = new ToolRunner(new ToolRegistry(createBuiltinTools()), createRuntimeContext());

    const result = await runner.run({
      id: "read-1",
      name: "Read",
      input: { path: file, offset: 2, limit: 2 },
    });

    assert.equal(result.isError, undefined);
    assert.match(result.content, /Lines 2-3/);
    assert.match(result.content, /2 \| beta/);
    assert.match(result.content, /3 \| gamma/);
    assert.doesNotMatch(result.content, /1 \| alpha/);
    assert.doesNotMatch(result.content, /4 \| delta/);
  });
});

test("Read caps default output and reports when more lines are available", async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, "long.txt");
    const content = Array.from({ length: 2_101 }, (_, index) => "line-" + (index + 1)).join("\n");
    await writeFile(file, content, "utf8");
    const runner = new ToolRunner(new ToolRegistry(createBuiltinTools()), createRuntimeContext());

    const result = await runner.run({ id: "read-1", name: "Read", input: { path: file } });

    assert.equal(result.isError, undefined);
    assert.match(result.content, /Lines 1-200/);
    assert.match(result.content, /1 \| line-1/);
    assert.match(result.content, /200 \| line-200/);
    assert.doesNotMatch(result.content, /201 \| line-201/);
    assert.match(result.content, /truncated/i);
    assert.match(result.content, /offset: 201/);
  });
});

test("Edit rejects files changed since the last Read", async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, "note.txt");
    await writeFile(file, "hello", "utf8");
    const context = createRuntimeContext();
    const runner = new ToolRunner(new ToolRegistry(createBuiltinTools()), context);

    await runner.run({ id: "read-1", name: "Read", input: { path: file } });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await writeFile(file, "external change", "utf8");

    const edit = await runner.run({
      id: "edit-1",
      name: "Edit",
      input: { path: file, oldText: "hello", newText: "hi" },
    });

    assert.equal(edit.isError, true);
    assert.match(edit.content, /changed since it was read/i);
  });
});
