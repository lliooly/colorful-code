import type { McpServerConfigWithTrust } from '../config/mcp-config';
import type { LspServerConfig } from '@colorful-code/tool-runtime';

export type PluginKind = 'mcp' | 'skill' | 'lsp';

export type McpRegistryPackage = {
  name?: string;
  identifier?: string;
  registry?: string;
  registryType?: string;
  version?: string;
  transport?:
    | string
    | {
        type?: string;
        url?: string;
      };
  url?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  [key: string]: unknown;
};

export type McpRegistryRemote = {
  type?: string;
  url?: string;
  [key: string]: unknown;
};

export type McpRegistryServer = {
  name: string;
  title?: string;
  description?: string;
  version?: string;
  packages?: McpRegistryPackage[];
  remotes?: McpRegistryRemote[];
};

export type McpRegistryListResponse = {
  servers: Array<{ server: McpRegistryServer }>;
  metadata?: {
    count?: number;
    nextCursor?: string;
  };
};

export type InstalledPlugin = {
  id: string;
  kind: PluginKind;
  registryName: string;
  title?: string;
  description?: string;
  version: string;
  enabled: boolean;
  config: InstalledPluginConfig;
  installedAt: number;
  updatedAt: number;
};

export type SkillPluginConfig = {
  type: 'skill';
  source: 'github' | 'local';
  repository?: string;
  path: string;
  entry: string;
  installHint?: string;
};

export type LspPluginConfig = LspServerConfig;

export type InstalledPluginConfig =
  | McpServerConfigWithTrust
  | SkillPluginConfig
  | LspPluginConfig;

export type InstallMcpPluginInput = {
  registryName: string;
  title?: string;
  description?: string;
  version: string;
  config: McpServerConfigWithTrust;
};

export type InstallCatalogPluginInput = {
  kind: Exclude<PluginKind, 'mcp'>;
  registryName: string;
  title?: string;
  description?: string;
  version: string;
  config: SkillPluginConfig | LspPluginConfig;
};

export type InstalledPluginPatch = {
  enabled?: boolean;
  trust?: McpServerConfigWithTrust['trust'];
};

export type CatalogPlugin = {
  kind: Exclude<PluginKind, 'mcp'>;
  name: string;
  title: string;
  description: string;
  version: string;
  config: SkillPluginConfig | LspPluginConfig;
};
