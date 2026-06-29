import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  CallToolResultSchema,
  ListResourcesResultSchema,
  ListToolsResultSchema,
  ReadResourceResultSchema,
  type Resource,
  type Tool as SdkTool,
} from '@modelcontextprotocol/sdk/types.js';
import type { JsonObject } from '../core/tool.js';
import type {
  McpManager,
  McpReadResourceResult,
  McpResourceContent,
  McpResourceMetadata,
  McpServerConfig,
  McpServerConnection,
  McpToolMetadata,
} from './types.js';

type ConnectedClient = {
  name: string;
  config: McpServerConfig;
  client: Client;
  close: () => Promise<void>;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function createClient(): Client {
  return new Client(
    { name: 'colorful-code', version: '0.0.0' },
    { capabilities: { roots: {} } },
  );
}

async function connectClient(
  name: string,
  config: McpServerConfig,
): Promise<ConnectedClient> {
  const client = createClient();
  const transport =
    config.type === 'http'
      ? new StreamableHTTPClientTransport(new URL(config.url), {
          requestInit: { headers: config.headers },
        })
      : config.type === 'sse'
        ? new SSEClientTransport(new URL(config.url), {
            requestInit: { headers: config.headers },
          })
        : new StdioClientTransport({
            command: config.command,
            args: config.args ?? [],
            env: config.env,
            stderr: 'pipe',
          });

  await client.connect(transport);
  return {
    name,
    config,
    client,
    close: async () => {
      await client.close();
    },
  };
}

function toToolMetadata(server: string, tool: SdkTool): McpToolMetadata {
  return {
    server,
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: tool.annotations,
  };
}

function toResourceMetadata(
  server: string,
  resource: Resource,
): McpResourceMetadata {
  return {
    server,
    uri: resource.uri,
    name: resource.name,
    mimeType: resource.mimeType,
    description: resource.description,
  };
}

function toResourceContent(
  server: string,
  content: { uri: string; mimeType?: string; text?: string; blob?: string },
): McpResourceContent {
  return {
    server,
    uri: content.uri,
    mimeType: content.mimeType,
    text: content.text,
    blob: content.blob,
  };
}

export class SdkMcpManager implements McpManager {
  private readonly connected = new Map<string, ConnectedClient>();
  private readonly cachedConnections = new Map<string, McpServerConnection>();

  constructor(private readonly configs: Record<string, McpServerConfig>) {}

  async connectAll(): Promise<McpServerConnection[]> {
    const results = await Promise.all(
      Object.entries(this.configs).map(async ([name, config]) =>
        this.connectOne(name, config),
      ),
    );
    return results;
  }

  async callTool(
    server: string,
    tool: string,
    args: JsonObject,
  ): Promise<unknown> {
    const connection = await this.ensureConnected(server);
    return await connection.client.callTool(
      { name: tool, arguments: args },
      CallToolResultSchema,
    );
  }

  async listResources(server?: string): Promise<McpResourceMetadata[]> {
    const connections = await this.connectAll();
    return connections
      .filter(
        (connection) =>
          connection.type === 'connected' &&
          (!server || connection.name === server),
      )
      .flatMap((connection) =>
        connection.type === 'connected' ? connection.resources : [],
      );
  }

  async readResource(
    server: string,
    uri: string,
  ): Promise<McpReadResourceResult> {
    const connection = await this.ensureConnected(server);
    const result = await connection.client.request(
      { method: 'resources/read', params: { uri } },
      ReadResourceResultSchema,
    );
    return {
      contents: result.contents.map((content) =>
        toResourceContent(server, content),
      ),
    };
  }

  async close(): Promise<void> {
    await Promise.all(
      [...this.connected.values()].map((connection) => connection.close()),
    );
    this.connected.clear();
    this.cachedConnections.clear();
  }

  private async connectOne(
    name: string,
    config: McpServerConfig,
  ): Promise<McpServerConnection> {
    const cached = this.cachedConnections.get(name);
    if (cached) {
      return cached;
    }

    try {
      const connection = await connectClient(name, config);
      this.connected.set(name, connection);
      const capabilities = connection.client.getServerCapabilities();

      const tools = capabilities?.tools
        ? (
            await connection.client.request(
              { method: 'tools/list' },
              ListToolsResultSchema,
            )
          ).tools.map((tool) => toToolMetadata(name, tool))
        : [];

      const resources = capabilities?.resources
        ? (
            await connection.client.request(
              { method: 'resources/list' },
              ListResourcesResultSchema,
            )
          ).resources.map((resource) => toResourceMetadata(name, resource))
        : [];

      const result: McpServerConnection = {
        name,
        type: 'connected',
        config,
        tools,
        resources,
        instructions: connection.client.getInstructions(),
        close: connection.close,
      };
      this.cachedConnections.set(name, result);
      return result;
    } catch (error) {
      const result: McpServerConnection = {
        name,
        type: 'failed',
        config,
        error: errorMessage(error),
      };
      this.cachedConnections.set(name, result);
      return result;
    }
  }

  private async ensureConnected(server: string): Promise<ConnectedClient> {
    const existing = this.connected.get(server);
    if (existing) {
      return existing;
    }
    const config = this.configs[server];
    if (!config) {
      throw new Error('MCP server not configured: ' + server);
    }
    const connection = await this.connectOne(server, config);
    if (connection.type !== 'connected') {
      throw new Error('MCP server failed to connect: ' + connection.error);
    }
    const connected = this.connected.get(server);
    if (!connected) {
      throw new Error('MCP server is not connected: ' + server);
    }
    return connected;
  }
}
