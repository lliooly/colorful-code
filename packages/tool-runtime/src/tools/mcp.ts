import {
  objectSchema,
  optionalField,
  stringField,
  objectField,
} from '../core/schema.js';
import { buildTool, type RuntimeContext, type Tool } from '../core/tool.js';

const readResourceSchema = objectSchema({
  server: optionalField(stringField()),
  uri: stringField(),
});
const mcpToolSchema = objectSchema({
  server: stringField(),
  tool: stringField(),
  args: optionalField(objectField()),
});
const authSchema = objectSchema({
  server: stringField(),
  token: optionalField(stringField()),
});
const listResourceSchema = objectSchema({
  server: optionalField(stringField()),
});

function ensureResources(context: RuntimeContext) {
  if (!context.mcpResources) context.mcpResources = new Map();
  return context.mcpResources;
}

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

function mapMcpToolResult(result: unknown): string {
  if (result && typeof result === 'object') {
    const value = result as { content?: unknown; structuredContent?: unknown };
    if (value.structuredContent !== undefined) {
      return stringifyMcpContent(value.structuredContent);
    }
    if (value.content !== undefined) {
      return stringifyMcpContent(value.content);
    }
  }
  return stringifyMcpContent(result);
}

export const MCPTool = buildTool({
  name: 'MCPTool',
  aliases: ['mcp'],
  inputSchema: mcpToolSchema,
  async call(input, context) {
    if (context.mcpManager) {
      const result = await context.mcpManager.callTool(
        input.server,
        input.tool,
        input.args ?? {},
      );
      return { data: mapMcpToolResult(result) };
    }
    if (!context.mcpToolProvider) {
      throw new Error(
        'MCP provider not configured for ' + input.server + '/' + input.tool,
      );
    }
    const result = await context.mcpToolProvider(
      input.server,
      input.tool,
      input.args ?? {},
    );
    return { data: mapMcpToolResult(result) };
  },
  mapResult(data, toolUseId) {
    return { toolUseId, content: data };
  },
});

export const McpAuthTool = buildTool({
  name: 'McpAuth',
  inputSchema: authSchema,
  async call(input, context) {
    if (!context.config) context.config = new Map();
    if (input.token)
      context.config.set('mcp:' + input.server + ':token', input.token);
    return { data: 'MCP auth recorded for ' + input.server };
  },
  mapResult(data, toolUseId) {
    return { toolUseId, content: data };
  },
});

export const ListMcpResourcesTool = buildTool({
  name: 'ListMcpResourcesTool',
  inputSchema: listResourceSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  async call(input, context) {
    if (context.mcpManager) {
      const resources = await context.mcpManager.listResources(input.server);
      return {
        data: resources.map((resource) =>
          [resource.server, resource.uri, resource.name, resource.description]
            .filter(Boolean)
            .join(' '),
        ),
      };
    }
    return {
      data: [...ensureResources(context).values()].map(
        (resource) => resource.uri + (resource.name ? ' ' + resource.name : ''),
      ),
    };
  },
  mapResult(data, toolUseId) {
    return { toolUseId, content: data.join('\n') };
  },
});

export const ReadMcpResourceTool = buildTool({
  name: 'ReadMcpResourceTool',
  inputSchema: readResourceSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  async call(input, context) {
    if (context.mcpManager) {
      const server = input.server;
      if (!server)
        throw new Error(
          'MCP server is required when reading manager-backed resources',
        );
      const result = await context.mcpManager.readResource(server, input.uri);
      return {
        data: result.contents
          .map((content) => content.text ?? content.blob ?? '')
          .filter(Boolean)
          .join('\n'),
      };
    }
    const resource = ensureResources(context).get(input.uri);
    if (!resource) throw new Error('MCP resource not found: ' + input.uri);
    return { data: resource.content };
  },
  mapResult(data, toolUseId) {
    return { toolUseId, content: data };
  },
});

export function createMcpTools(): Tool[] {
  return [MCPTool, McpAuthTool, ListMcpResourcesTool, ReadMcpResourceTool];
}
