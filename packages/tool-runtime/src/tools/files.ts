import { createReadStream } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { dirname, resolve } from "node:path";
import {
  objectSchema,
  optionalField,
  stringField,
  booleanField,
  numberField,
} from "../core/schema.js";
import { buildTool, type RuntimeContext, type Tool } from "../core/tool.js";

const DEFAULT_READ_LIMIT_LINES = 200;
const MAX_READ_LIMIT_LINES = 2_000;
const MAX_COMPLETE_READ_BYTES = 1_000_000;

function absolutePath(filePath: string, context: RuntimeContext): string {
  return resolve(context.cwd ?? process.cwd(), filePath);
}

function requireFileState(context: RuntimeContext) {
  if (!context.fileState) {
    context.fileState = new Map();
  }
  return context.fileState;
}

const readInputSchema = objectSchema({
  path: stringField(),
  offset: optionalField(numberField()),
  limit: optionalField(numberField()),
});
const writeInputSchema = objectSchema({ path: stringField(), content: stringField() });
const editInputSchema = objectSchema({
  path: stringField(),
  oldText: stringField(),
  newText: stringField(),
  replaceAll: optionalField(booleanField()),
});

type ReadInput = ReturnType<typeof readInputSchema.parse>;
type WriteInput = ReturnType<typeof writeInputSchema.parse>;
type EditInput = ReturnType<typeof editInputSchema.parse>;

type ReadOutput = {
  path: string;
  lines: Array<{ number: number; text: string }>;
  startLine: number;
  endLine: number;
  requestedLimit: number;
  effectiveLimit: number;
  truncated: boolean;
};
type WriteOutput = { path: string; bytes: number };
type EditOutput = { path: string; replacements: number };

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(name + " must be a positive integer.");
  }
  return value;
}

async function readLinePage(
  filePath: string,
  offset: number,
  limit: number,
): Promise<{
  lines: Array<{ number: number; text: string }>;
  truncated: boolean;
}> {
  const stream = createReadStream(filePath, { encoding: "utf8" });
  const reader = createInterface({
    input: stream,
    crlfDelay: Infinity,
  });
  const lines: Array<{ number: number; text: string }> = [];
  let lineNumber = 0;
  let truncated = false;

  try {
    for await (const line of reader) {
      lineNumber += 1;
      if (lineNumber < offset) {
        continue;
      }
      if (lines.length >= limit) {
        truncated = true;
        break;
      }
      lines.push({ number: lineNumber, text: line });
    }
  } finally {
    reader.close();
    stream.destroy();
  }

  return { lines, truncated };
}

function formatReadOutput(data: ReadOutput): string {
  const header = [
    "Read " + data.path,
    "Lines " + data.startLine + "-" + data.endLine,
  ];
  if (data.requestedLimit !== data.effectiveLimit) {
    header.push(
      "Limit capped at " +
        data.effectiveLimit +
        " lines (requested " +
        data.requestedLimit +
        ").",
    );
  }

  const body = data.lines
    .map((line) => String(line.number) + " | " + line.text)
    .join("\n");
  const footer = data.truncated
    ? "\n\n[truncated: more lines available. Use offset: " +
      (data.endLine + 1) +
      ", limit: " +
      data.effectiveLimit +
      " to continue.]"
    : "";

  return header.join("\n") + "\n\n" + body + footer;
}

export const ReadTool = buildTool<ReadInput, ReadOutput>({
  name: "Read",
  aliases: ["FileRead"],
  inputSchema: readInputSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  async call(input, context) {
    const filePath = absolutePath(input.path, context);
    const offset = positiveInteger(input.offset ?? 1, "offset");
    const requestedLimit = positiveInteger(
      input.limit ?? DEFAULT_READ_LIMIT_LINES,
      "limit",
    );
    const effectiveLimit = Math.min(requestedLimit, MAX_READ_LIMIT_LINES);
    const stats = await stat(filePath);
    const page = await readLinePage(filePath, offset, effectiveLimit);
    const complete = offset === 1 && !page.truncated;
    const canStoreCompleteSnapshot =
      complete && stats.size <= MAX_COMPLETE_READ_BYTES;
    const snapshotContent = canStoreCompleteSnapshot
      ? await readFile(filePath, "utf8")
      : "";
    requireFileState(context).set(filePath, {
      content: snapshotContent,
      mtimeMs: stats.mtimeMs,
      complete: canStoreCompleteSnapshot,
    });
    const endLine =
      page.lines.length > 0
        ? page.lines[page.lines.length - 1]!.number
        : offset - 1;
    return {
      data: {
        path: filePath,
        lines: page.lines,
        startLine: offset,
        endLine,
        requestedLimit,
        effectiveLimit,
        truncated: page.truncated || requestedLimit > effectiveLimit,
      },
    };
  },
  mapResult(data, toolUseId) {
    return { toolUseId, content: formatReadOutput(data) };
  },
});

export const WriteTool = buildTool<WriteInput, WriteOutput>({
  name: "Write",
  aliases: ["FileWrite"],
  inputSchema: writeInputSchema,
  isDestructive: () => true,
  async call(input, context) {
    const filePath = absolutePath(input.path, context);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, input.content, "utf8");
    const stats = await stat(filePath);
    requireFileState(context).set(filePath, {
      content: input.content,
      mtimeMs: stats.mtimeMs,
      complete: true,
    });
    return { data: { path: filePath, bytes: Buffer.byteLength(input.content) } };
  },
  mapResult(data, toolUseId) {
    return { toolUseId, content: "Wrote " + data.bytes + " bytes to " + data.path };
  },
});

export const EditTool = buildTool<EditInput, EditOutput>({
  name: "Edit",
  aliases: ["FileEdit"],
  inputSchema: editInputSchema,
  isDestructive: () => true,
  validateInput(input, context) {
    if (input.oldText === input.newText) {
      return { ok: false, message: "No edit to apply: oldText and newText are identical." };
    }
    const filePath = absolutePath(input.path, context);
    const snapshot = context.fileState?.get(filePath);
    if (!snapshot?.complete) {
      return { ok: false, message: "Read before editing: this file has not been read completely." };
    }
    return { ok: true };
  },
  async call(input, context) {
    const filePath = absolutePath(input.path, context);
    const snapshot = requireFileState(context).get(filePath);
    if (!snapshot?.complete) {
      throw new Error("Read before editing: this file has not been read completely.");
    }

    const current = await readFile(filePath, "utf8");
    const stats = await stat(filePath);
    if (current !== snapshot.content && stats.mtimeMs >= snapshot.mtimeMs) {
      throw new Error("File changed since it was read. Read it again before editing.");
    }

    const matchCount = input.replaceAll === true
      ? current.split(input.oldText).length - 1
      : current.includes(input.oldText)
        ? 1
        : 0;
    if (matchCount === 0) {
      throw new Error("oldText was not found in the current file content.");
    }

    let updated: string;
    if (input.replaceAll === true) {
      updated = current.split(input.oldText).join(input.newText);
    } else {
      const index = current.indexOf(input.oldText);
      updated = current.slice(0, index) + input.newText + current.slice(index + input.oldText.length);
    }

    await writeFile(filePath, updated, "utf8");
    const updatedStats = await stat(filePath);
    requireFileState(context).set(filePath, {
      content: updated,
      mtimeMs: updatedStats.mtimeMs,
      complete: true,
    });
    return { data: { path: filePath, replacements: matchCount } };
  },
  mapResult(data, toolUseId) {
    return {
      toolUseId,
      content: "Edited " + data.path + " (" + data.replacements + " replacement" + (data.replacements === 1 ? "" : "s") + ").",
    };
  },
});

export function createFileTools(): Tool[] {
  return [ReadTool, WriteTool, EditTool];
}
