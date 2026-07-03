import type { McpServerConfigWithTrust } from '../config/mcp-config';
import type {
  McpRegistryListResponse,
  McpRegistryRemote,
  McpRegistryServer,
} from './plugin-types';

export const PLUGIN_REGISTRY_CLIENT = Symbol('PLUGIN_REGISTRY_CLIENT');

export type RegistryListOptions = {
  limit?: number;
  cursor?: string;
};

export type McpRegistryClient = {
  listServers(options?: RegistryListOptions): Promise<McpRegistryListResponse>;
  getServerVersion(name: string, version?: string): Promise<McpRegistryServer>;
};

const MCP_REGISTRY_BASE_URL = 'https://registry.modelcontextprotocol.io';

function packageIdentifier(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0
    ? value
    : undefined;
}

function registryType(value: unknown): string {
  return typeof value === 'string' && value.trim().length > 0 ? value : 'npm';
}

function transportType(value: unknown): string {
  if (typeof value === 'string' && value.trim().length > 0) {
    return value;
  }
  if (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { type?: unknown }).type === 'string' &&
    (value as { type: string }).type.trim().length > 0
  ) {
    return (value as { type: string }).type;
  }
  return 'stdio';
}

function mcpConfigTransportType(
  value: unknown,
): 'stdio' | 'http' | 'sse' | undefined {
  const transport = transportType(value);
  if (transport === 'streamable-http') {
    return 'http';
  }
  if (transport === 'stdio' || transport === 'http' || transport === 'sse') {
    return transport;
  }
  return undefined;
}

function transportUrl(
  itemUrl: unknown,
  transport: unknown,
): string | undefined {
  if (typeof itemUrl === 'string' && itemUrl.trim().length > 0) {
    return itemUrl;
  }
  if (
    typeof transport === 'object' &&
    transport !== null &&
    typeof (transport as { url?: unknown }).url === 'string' &&
    (transport as { url: string }).url.trim().length > 0
  ) {
    return (transport as { url: string }).url;
  }
  return undefined;
}

function remoteConfig(
  remote: McpRegistryRemote,
): McpServerConfigWithTrust | undefined {
  const transport = mcpConfigTransportType(remote.type);
  if ((transport === 'http' || transport === 'sse') && remote.url) {
    return {
      type: transport,
      url: remote.url,
      trust: 'ask',
    };
  }
  return undefined;
}

function queryString(options: RegistryListOptions): string {
  const params = new URLSearchParams();
  if (options.limit !== undefined) {
    params.set('limit', String(options.limit));
  }
  if (options.cursor) {
    params.set('cursor', options.cursor);
  }
  const query = params.toString();
  return query ? '?' + query : '';
}

function unwrapRegistryServer(value: unknown): McpRegistryServer {
  if (
    typeof value === 'object' &&
    value !== null &&
    'server' in value &&
    typeof (value as { server?: unknown }).server === 'object' &&
    (value as { server?: unknown }).server !== null
  ) {
    return (value as { server: McpRegistryServer }).server;
  }
  return value as McpRegistryServer;
}

export class PublicMcpRegistryClient implements McpRegistryClient {
  constructor(private readonly baseUrl = MCP_REGISTRY_BASE_URL) {}

  async listServers(
    options: RegistryListOptions = {},
  ): Promise<McpRegistryListResponse> {
    const response = await fetch(
      this.baseUrl + '/v0.1/servers' + queryString(options),
    );
    if (!response.ok) {
      throw new Error(
        `MCP Registry list failed: ${String(response.status)} ${response.statusText}`,
      );
    }
    return (await response.json()) as McpRegistryListResponse;
  }

  async getServerVersion(
    name: string,
    version = 'latest',
  ): Promise<McpRegistryServer> {
    const response = await fetch(
      this.baseUrl +
        '/v0.1/servers/' +
        encodeURIComponent(name) +
        '/versions/' +
        encodeURIComponent(version),
    );
    if (!response.ok) {
      throw new Error(
        `MCP Registry detail failed: ${String(response.status)} ${response.statusText}`,
      );
    }
    return unwrapRegistryServer(await response.json());
  }
}

export function deriveMcpConfigFromRegistryServer(
  server: McpRegistryServer,
): McpServerConfigWithTrust {
  for (const remote of server.remotes ?? []) {
    const config = remoteConfig(remote);
    if (config) {
      return config;
    }
  }

  for (const item of server.packages ?? []) {
    const pkgName =
      packageIdentifier(item.identifier) ?? packageIdentifier(item.name);
    const registry = registryType(item.registryType ?? item.registry);
    const transport = mcpConfigTransportType(item.transport);
    const url = transportUrl(item.url, item.transport);

    if (transport === 'stdio' && pkgName) {
      if (item.command) {
        return {
          type: 'stdio',
          command: item.command,
          args: item.args ?? [],
          trust: 'ask',
        };
      }
      if (registry === 'pypi') {
        return {
          type: 'stdio',
          command: 'uvx',
          args: [pkgName],
          trust: 'ask',
        };
      }
      if (registry === 'npm') {
        return {
          type: 'stdio',
          command: 'npx',
          args: ['-y', pkgName],
          trust: 'ask',
        };
      }
    }

    if ((transport === 'http' || transport === 'sse') && url) {
      return {
        type: transport,
        url,
        trust: 'ask',
      };
    }
  }

  throw new Error('No supported MCP registry package found.');
}
