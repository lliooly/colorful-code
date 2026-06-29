import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  objectSchema,
  optionalField,
  stringField,
  booleanField,
} from "../core/schema.js";
import { buildTool, type RuntimeContext, type Tool } from "../core/tool.js";

function absolutePath(filePath: string, context: RuntimeContext): string {
  return resolve(context.cwd ?? process.cwd(), filePath);
}

function requireFileState(context: RuntimeContext) {
  if (!context.fileState) {
    context.fileState = new Map();
  }
  return context.fileState;
}

const readInputSchema = objectSchema({ path: stringField() });
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

type ReadOutput = { path: string; content: string };
type WriteOutput = { path: string; bytes: number };
type EditOutput = { path: string; replacements: number };

export const ReadTool = buildTool<ReadInput, ReadOutput>({
  name: "Read",
  aliases: ["FileRead"],
  inputSchema: readInputSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  async call(input, context) {
    const filePath = absolutePath(input.path, context);
    const content = await readFile(filePath, "utf8");
    const stats = await stat(filePath);
    requireFileState(context).set(filePath, {
      content,
      mtimeMs: stats.mtimeMs,
      complete: true,
    });
    return { data: { path: filePath, content } };
  },
  mapResult(data, toolUseId) {
    return { toolUseId, content: data.content };
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
