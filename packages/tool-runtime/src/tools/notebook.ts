import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { objectSchema, numberField, stringField } from "../core/schema.js";
import { buildTool, type Tool } from "../core/tool.js";

const notebookEditSchema = objectSchema({ path: stringField(), cellIndex: numberField(), source: stringField() });

export const NotebookEditTool = buildTool({
  name: "NotebookEdit",
  inputSchema: notebookEditSchema,
  isDestructive: () => true,
  async call(input, context) {
    const filePath = resolve(context.cwd ?? process.cwd(), input.path);
    const notebook = JSON.parse(await readFile(filePath, "utf8")) as { cells?: Array<{ source?: string[] | string }> };
    if (!Array.isArray(notebook.cells)) throw new Error("Notebook has no cells array.");
    const cell = notebook.cells[input.cellIndex];
    if (!cell) throw new Error("Notebook cell not found: " + input.cellIndex);
    cell.source = [input.source];
    await writeFile(filePath, JSON.stringify(notebook, null, 2), "utf8");
    return { data: filePath };
  },
  mapResult(data, toolUseId) {
    return { toolUseId, content: "Updated notebook " + data };
  },
});

export function createNotebookTools(): Tool[] {
  return [NotebookEditTool];
}
