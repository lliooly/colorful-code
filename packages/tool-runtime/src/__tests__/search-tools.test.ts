import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ToolRegistry,
  ToolRunner,
  createBuiltinTools,
  createRuntimeContext,
} from "../index.js";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "colorful-search-tools-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function outputLines(content: string): string[] {
  return content.split("\n").filter(Boolean);
}

test("Grep treats pattern as a regex and honors gitignore rules", async () => {
  await withTempDir(async (dir) => {
    await mkdir(join(dir, "src"), { recursive: true });
    await mkdir(join(dir, "ignored"), { recursive: true });
    await writeFile(join(dir, ".gitignore"), "ignored/\n*.log\n", "utf8");
    await writeFile(
      join(dir, "src", "match.ts"),
      "const answer = 42;\n",
      "utf8",
    );
    await writeFile(join(dir, "src", "miss.ts"), "const answer = 7;\n", "utf8");
    await writeFile(
      join(dir, "ignored", "match.ts"),
      "const answer = 42;\n",
      "utf8",
    );
    await writeFile(join(dir, "debug.log"), "const answer = 42;\n", "utf8");
    const runner = new ToolRunner(
      new ToolRegistry(createBuiltinTools()),
      createRuntimeContext(),
    );

    const result = await runner.run({
      id: "grep-1",
      name: "Grep",
      input: { cwd: dir, pattern: "answer\\s*=\\s*42" },
    });

    assert.equal(result.isError, undefined);
    assert.deepEqual(outputLines(result.content), [join(dir, "src", "match.ts")]);
  });
});

test("Glob honors gitignore rules", async () => {
  await withTempDir(async (dir) => {
    await mkdir(join(dir, "src"), { recursive: true });
    await mkdir(join(dir, "ignored"), { recursive: true });
    await writeFile(join(dir, ".gitignore"), "ignored/\n", "utf8");
    await writeFile(
      join(dir, "src", "visible.ts"),
      "export const visible = true;\n",
      "utf8",
    );
    await writeFile(
      join(dir, "ignored", "hidden.ts"),
      "export const hidden = true;\n",
      "utf8",
    );
    const runner = new ToolRunner(
      new ToolRegistry(createBuiltinTools()),
      createRuntimeContext(),
    );

    const result = await runner.run({
      id: "glob-1",
      name: "Glob",
      input: { cwd: dir, pattern: "**/*.ts" },
    });

    assert.equal(result.isError, undefined);
    assert.deepEqual(outputLines(result.content), [join(dir, "src", "visible.ts")]);
  });
});

test("Grep ignores ambient ripgrep configuration", async () => {
  await withTempDir(async (dir) => {
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "src", "match.ts"), "const answer = 42;\n", "utf8");
    const configPath = join(dir, "ripgreprc");
    await writeFile(configPath, "--glob=!src/**\n", "utf8");
    const previousConfig = process.env.RIPGREP_CONFIG_PATH;
    process.env.RIPGREP_CONFIG_PATH = configPath;
    try {
      const runner = new ToolRunner(
        new ToolRegistry(createBuiltinTools()),
        createRuntimeContext(),
      );
      const result = await runner.run({
        id: "grep-ambient-config",
        name: "Grep",
        input: { cwd: dir, pattern: "answer" },
      });

      assert.equal(result.isError, undefined);
      assert.deepEqual(outputLines(result.content), [join(dir, "src", "match.ts")]);
    } finally {
      if (previousConfig === undefined) {
        delete process.env.RIPGREP_CONFIG_PATH;
      } else {
        process.env.RIPGREP_CONFIG_PATH = previousConfig;
      }
    }
  });
});
