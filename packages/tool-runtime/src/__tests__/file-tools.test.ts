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
