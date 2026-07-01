import { objectSchema, stringField } from "../core/schema.js";
import { buildTool, type RuntimeContext, type Tool } from "../core/tool.js";
import type { PermissionResult } from "../core/permissions.js";
import type { JsonObject } from "../core/tool.js";

const fetchSchema = objectSchema({ url: stringField() });
const searchSchema = objectSchema({ query: stringField() });
type SearchInput = ReturnType<typeof searchSchema.parse>;

function parseNetworkUrl(url: string | undefined): URL | undefined {
  if (!url) return undefined;
  try {
    return new URL(url);
  } catch {
    return undefined;
  }
}

function searchEndpoint(context: RuntimeContext): string {
  return context.webSearchEndpoint ?? "https://duckduckgo.com/html/?q={query}";
}

function hostAllowed(host: string | undefined, allowlist: string[]): boolean {
  if (!host) return false;
  return allowlist.some((entry) => {
    const normalized = entry.toLowerCase();
    const target = host.toLowerCase();
    if (normalized.startsWith("*.")) {
      const suffix = normalized.slice(1);
      return target.endsWith(suffix);
    }
    return target === normalized;
  });
}

export function networkTargetForTool(
  provider: string,
  input: JsonObject,
  context: RuntimeContext,
) {
  const rawUrl =
    typeof input.url === "string"
      ? input.url
      : provider === "WebSearch"
        ? searchEndpoint(context)
        : undefined;
  const parsed = parseNetworkUrl(rawUrl);
  return {
    provider,
    ...(rawUrl ? { url: rawUrl } : {}),
    ...(parsed
      ? { host: parsed.hostname, scheme: parsed.protocol.replace(/:$/, "") }
      : {}),
  };
}

function checkNetworkPermission<Input extends JsonObject>(
  provider: string,
  input: Input,
  context: RuntimeContext,
): PermissionResult<Input> {
  const permissionContext = context.permissionContext;
  if (!permissionContext) return { behavior: "allow" };
  if (permissionContext.mode === "bypass") return { behavior: "allow" };

  const providerPolicy = permissionContext.networkProviders?.[provider];
  const target = networkTargetForTool(provider, input, context);
  if (providerPolicy === "deny") {
    return {
      behavior: "deny",
      message: provider + " is denied by network provider policy.",
      reason: {
        type: "policy",
        reason: provider + " denied by network provider policy.",
      },
    };
  }
  if (providerPolicy === "allow") return { behavior: "allow" };
  if (providerPolicy === "ask") {
    return {
      behavior: "ask",
      message: provider + " requires network approval.",
      reason: {
        type: "policy",
        reason: provider + " requires approval by network provider policy.",
      },
    };
  }

  if (permissionContext.allowNetwork === true) return { behavior: "allow" };
  if (
    target.host &&
    hostAllowed(target.host, permissionContext.hostAllowlist ?? [])
  ) {
    return { behavior: "allow" };
  }
  return {
    behavior: "ask",
    message:
      provider +
      " requires network access" +
      (target.url ? " to " + target.url : "") +
      ".",
    reason: {
      type: "policy",
      reason:
        "Network access requires allowNetwork, host allowlist, or provider policy.",
    },
  };
}

export const WebFetchTool = buildTool({
  name: "WebFetch",
  inputSchema: fetchSchema,
  checkPermissions(input, context) {
    return checkNetworkPermission("WebFetch", input, context);
  },
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
  checkPermissions(input: SearchInput, context) {
    return checkNetworkPermission("WebSearch", input, context);
  },
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
  checkPermissions(input, context) {
    return checkNetworkPermission("WebBrowser", input, context);
  },
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
