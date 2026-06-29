import { objectSchema, stringField } from "../core/schema.js";
import { buildTool, type Tool } from "../core/tool.js";

const fetchSchema = objectSchema({ url: stringField() });
const searchSchema = objectSchema({ query: stringField() });

export const WebFetchTool = buildTool({
  name: "WebFetch",
  inputSchema: fetchSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  async call(input, context) {
    if (context.webFetchProvider) return { data: await context.webFetchProvider(input.url) };
    if (typeof fetch !== "function") return { data: "fetch is not available in this runtime" };
    const timeout = AbortSignal.timeout(30_000);
    const signal = context.signal ? AbortSignal.any([context.signal, timeout]) : timeout;
    const response = await fetch(input.url, { signal });
    const text = await response.text();
    return { data: text.slice(0, 50_000) };
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
    return { data: ["WebSearch provider not configured. Query: " + input.query] };
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
  async call(input) {
    return { data: "Browser navigation requested: " + input.url };
  },
  mapResult(data, toolUseId) {
    return { toolUseId, content: data };
  },
});

export function createNetworkTools(): Tool[] {
  return [WebFetchTool, WebSearchTool, WebBrowserTool];
}
