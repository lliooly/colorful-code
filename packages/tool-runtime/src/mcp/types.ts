import type { JsonObject } from '../core/tool.js';

export type McpTransport = 'stdio' | 'http' | 'sse';

export type McpStdioServerConfig = {
  type?: 'stdio';
  command: string;
  args?: string[];
  env?: Record<string, string>;
};

export type McpHttpServerConfig = {
  type: 'http';
  url: string;
  headers?: Record<string, string>;
};

export type McpSseServerConfig = {
  type: 'sse';
  url: string;
  headers?: Record<string, string>;
};

export type McpServerConfig =
  | McpStdioServerConfig
  | McpHttpServerConfig
  | McpSseServerConfig;

export type McpToolAnnotations = {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  openWorldHint?: boolean;
};

export type McpToolMetadata = {
  server: string;
  name: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: McpToolAnnotations;
};

export type McpResourceMetadata = {
  server: string;
  uri: string;
  name?: string;
  mimeType?: string;
  description?: string;
};

export type McpResourceContent = {
  server: string;
  uri: string;
  mimeType?: string;
  text?: string;
  blob?: string;
};

export type McpServerConnection =
  | {
      name: string;
      type: 'connected';
      config: McpServerConfig;
      tools: McpToolMetadata[];
      resources: McpResourceMetadata[];
      instructions?: string;
      close?: () => Promise<void>;
    }
  | {
      name: string;
      type: 'failed';
      config: McpServerConfig;
      error: string;
    };

export type McpCallToolResult = {
  content?: unknown;
  structuredContent?: unknown;
  isError?: boolean;
};

export type McpReadResourceResult = {
  contents: McpResourceContent[];
};

export type McpManager = {
  connectAll(): Promise<McpServerConnection[]>;
  callTool(server: string, tool: string, args: JsonObject): Promise<unknown>;
  listResources(server?: string): Promise<McpResourceMetadata[]>;
  readResource(server: string, uri: string): Promise<McpReadResourceResult>;
  close?(): Promise<void>;
};
