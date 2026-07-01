import type { Tool } from '../core/tool.js';
import { createLspTools } from '../tools/lsp.js';

export async function createLspRuntimeTools(): Promise<Tool[]> {
  return createLspTools();
}
