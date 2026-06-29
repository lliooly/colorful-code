import {
  passthroughObjectSchema,
  type ToolInputJSONSchema,
} from '../core/schema.js';
import { buildTool, type JsonObject, type Tool } from '../core/tool.js';
import { createMcpTools } from '../tools/mcp.js';
import { buildMcpToolName } from './name.js';
import type {
  McpCallToolResult,
  McpManager,
  McpToolMetadata,
} from './types.js';

function stringifyMcpContent(content: unknown): string {
  if (content === undefined || content === null) {
    return '';
  }
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (
          item &&
          typeof item === 'object' &&
          'text' in item &&
          typeof item.text === 'string'
        ) {
          return item.text;
        }
        return JSON.stringify(item);
      })
      .join('\n');
  }
  return JSON.stringify(content);
}

export function mapMcpCallResult(result: unknown): string {
  if (result && typeof result === 'object') {
    const value = result as McpCallToolResult;
    if (value.structuredContent !== undefined) {
      return stringifyMcpContent(value.structuredContent);
    }
    if (value.content !== undefined) {
      return stringifyMcpContent(value.content);
    }
  }
  return stringifyMcpContent(result);
}

// MCP servers own their own validation, so runtime `.parse()` stays a passthrough.
// The descriptor contract, however, must surface the server's real `inputSchema`
// when it is a JSON Schema object; otherwise the model sees only a passthrough.
function mcpInputJSONSchema(
  inputSchema: unknown,
): ToolInputJSONSchema | undefined {
  if (
    inputSchema &&
    typeof inputSchema === 'object' &&
    !Array.isArray(inputSchema) &&
    (inputSchema as { type?: unknown }).type === 'object'
  ) {
    return inputSchema as ToolInputJSONSchema;
  }
  return undefined;
}

export function createToolFromMcpMetadata(
  metadata: McpToolMetadata,
  manager: McpManager,
): Tool<JsonObject, string> {
  const inputJSONSchema = mcpInputJSONSchema(metadata.inputSchema);
  const title = metadata.annotations?.title;
  return buildTool({
    name: buildMcpToolName(metadata.server, metadata.name),
    source: 'mcp',
    ...(metadata.description ? { description: metadata.description } : {}),
    ...(title ? { searchHint: title } : {}),
    inputSchema: passthroughObjectSchema(),
    ...(inputJSONSchema ? { inputJSONSchema } : {}),
    async call(input) {
      const result = await manager.callTool(
        metadata.server,
        metadata.name,
        input,
      );
      return { data: mapMcpCallResult(result) };
    },
    mapResult(data, toolUseId) {
      return { toolUseId, content: data };
    },
    isReadOnly() {
      return metadata.annotations?.readOnlyHint ?? false;
    },
    isConcurrencySafe() {
      return metadata.annotations?.readOnlyHint ?? false;
    },
    isDestructive() {
      return metadata.annotations?.destructiveHint ?? false;
    },
  });
}

export async function createMcpRuntimeTools(
  manager: McpManager,
): Promise<Tool[]> {
  const connections = await manager.connectAll();
  const dynamicTools = connections.flatMap((connection) =>
    connection.type === 'connected'
      ? connection.tools.map((tool) => createToolFromMcpMetadata(tool, manager))
      : [],
  );
  return [...dynamicTools, ...createMcpTools()];
}
