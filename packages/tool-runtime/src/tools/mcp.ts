import { objectSchema, optionalField, stringField, objectField } from "../core/schema.js";
import { buildTool, type RuntimeContext, type Tool } from "../core/tool.js";

const readResourceSchema = objectSchema({ uri: stringField() });
const mcpToolSchema = objectSchema({ server: stringField(), tool: stringField(), args: optionalField(objectField()) });
const authSchema = objectSchema({ server: stringField(), token: optionalField(stringField()) });

function ensureResources(context: RuntimeContext) {
  if (!context.mcpResources) context.mcpResources = new Map();
  return context.mcpResources;
}

export const MCPTool = buildTool({
  name: "MCPTool",
  aliases: ["mcp"],
  inputSchema: mcpToolSchema,
  async call(input, context) {
    if (!context.mcpToolProvider) {
      return { data: "MCP provider not configured for " + input.server + "/" + input.tool };
    }
    const result = await context.mcpToolProvider(input.server, input.tool, input.args ?? {});
    return { data: typeof result === "string" ? result : JSON.stringify(result) };
  },
  mapResult(data, toolUseId) {
    return { toolUseId, content: data };
  },
});

export const McpAuthTool = buildTool({
  name: "McpAuth",
  inputSchema: authSchema,
  async call(input, context) {
    if (!context.config) context.config = new Map();
    if (input.token) context.config.set("mcp:" + input.server + ":token", input.token);
    return { data: "MCP auth recorded for " + input.server };
  },
  mapResult(data, toolUseId) {
    return { toolUseId, content: data };
  },
});

export const ListMcpResourcesTool = buildTool({
  name: "ListMcpResourcesTool",
  inputSchema: objectSchema({}),
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  async call(_input, context) {
    return { data: [...ensureResources(context).values()].map((resource) => resource.uri + (resource.name ? " " + resource.name : "")) };
  },
  mapResult(data, toolUseId) {
    return { toolUseId, content: data.join("\n") };
  },
});

export const ReadMcpResourceTool = buildTool({
  name: "ReadMcpResourceTool",
  inputSchema: readResourceSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  async call(input, context) {
    const resource = ensureResources(context).get(input.uri);
    if (!resource) throw new Error("MCP resource not found: " + input.uri);
    return { data: resource.content };
  },
  mapResult(data, toolUseId) {
    return { toolUseId, content: data };
  },
});

export function createMcpTools(): Tool[] {
  return [MCPTool, McpAuthTool, ListMcpResourcesTool, ReadMcpResourceTool];
}
