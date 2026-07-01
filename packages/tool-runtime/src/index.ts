export * from './core/schema.js';
export * from './core/tool.js';
export * from './core/permissions.js';
export * from './core/descriptor.js';
export * from './core/registry.js';
export * from './core/runner.js';
export * from './core/scheduler.js';
export * from './core/hooks.js';
export * from './mcp/types.js';
export * from './mcp/name.js';
export * from './mcp/adapter.js';
export * from './mcp/client.js';
export * from './tools/files.js';
export * from './tools/bash.js';
export * from './tools/search.js';
export * from './tools/notebook.js';
export * from './tools/workflow.js';
export * from './tools/tasks.js';
export * from './tools/mcp.js';
export * from './tools/network.js';
export * from './tools/misc.js';
export * from './session/index.js';
export * from './session/file-watcher.js';

import type { Tool } from './core/tool.js';
import { createBashTools } from './tools/bash.js';
import { createFileTools } from './tools/files.js';
import { createSearchTools } from './tools/search.js';
import { createNotebookTools } from './tools/notebook.js';
import { createWorkflowTools } from './tools/workflow.js';
import { createTaskTools } from './tools/tasks.js';
import { createMcpTools } from './tools/mcp.js';
import { createNetworkTools } from './tools/network.js';
import { createMiscTools } from './tools/misc.js';

export function createBuiltinTools(): Tool[] {
  return [
    ...createTaskTools(),
    ...createBashTools(),
    ...createSearchTools(),
    ...createWorkflowTools(),
    ...createFileTools(),
    ...createNotebookTools(),
    ...createNetworkTools(),
    ...createMcpTools(),
    ...createMiscTools(),
  ];
}
