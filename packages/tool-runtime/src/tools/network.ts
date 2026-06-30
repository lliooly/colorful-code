import { objectSchema, stringField } from "../core/schema.js";
import { buildTool, type RuntimeContext, type Tool } from "../core/tool.js";
import type { PermissionResult } from "../core/permissions.js";

const fetchSchema = objectSchema({ url: stringField() });
const searchSchema = objectSchema({ query: stringField() });
type FetchInput = ReturnType<typeof fetchSchema.parse>;

function checkNetworkPermission(
  input: FetchInput,
  context: RuntimeContext,
): PermissionResult<FetchInput> {
  const permissionContext = context.permissionContext;
  if (!permissionContext) return { behavior: "allow" };
  if (permissionContext.mode !== "default") return { behavior: "allow" };
  if (permissionContext.allowNetwork === true) return { behavior: "allow" };
  return {
    behavior: "ask",
    message: "WebFetch requires network access to " + input.url + ".",
    reason: {
      type: "policy",
      reason: "Network access requires explicit allowNetwork in default mode.",
    },
  };
}

export const WebFetchTool = buildTool({
  name: "WebFetch",
  inputSchema: fetchSchema,
  checkPermissions: checkNetworkPermission,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  async call(input, context) {
    if (!context.webFetchProvider) {
      throw new Error("WebFetch provider not configured for " + input.url);
    }
    return { data: await context.webFetchProvider(input.url) };
  },
  mapResult(data, toolUseId) {
    return { toolUseId, content: data };
  },
});

export const WebSearchTool = buildTool({
  name: "WebSearch",
  inputSchema: searchSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  async call(input, context) {
    if (context.webSearchProvider) return { data: await context.webSearchProvider(input.query) };
    throw new Error("WebSearch provider not configured for " + input.query);
  },
  mapResult(data, toolUseId) {
    return { toolUseId, content: data.join("\n") };
  },
});

export const WebBrowserTool = buildTool({
  name: "WebBrowser",
  inputSchema: fetchSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  async call(input, context) {
    if (!context.webBrowserProvider) {
      throw new Error("WebBrowser provider not configured for " + input.url);
    }
    return { data: await context.webBrowserProvider(input.url) };
  },
  mapResult(data, toolUseId) {
    return { toolUseId, content: data };
  },
});

export function createNetworkTools(): Tool[] {
  return [WebFetchTool, WebSearchTool, WebBrowserTool];
}
