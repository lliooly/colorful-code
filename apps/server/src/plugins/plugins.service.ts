import {
  BadRequestException,
  BadGatewayException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { McpTrustLevel } from '@colorful-code/tool-runtime';
import {
  findMcpCatalog,
  findLspCatalog,
  findSkillCatalog,
  listMcpCatalog,
  listLspCatalog,
  listSkillCatalog,
} from './plugin-catalog';
import {
  deriveMcpConfigFromRegistryServer,
  PLUGIN_REGISTRY_CLIENT,
  type McpRegistryClient,
  type RegistryListOptions,
} from './plugin-registry';
import { PluginStore } from './plugin-store';
import type {
  InstalledPlugin,
  PluginKind,
  McpRegistryListResponse,
  McpRegistryServer,
} from './plugin-types';

const TRUST_LEVELS: readonly McpTrustLevel[] = ['trusted', 'ask', 'blocked'];

function mergeRegistryServers(
  base: McpRegistryListResponse,
  demos: McpRegistryServer[],
): McpRegistryListResponse {
  const seen = new Set<string>();
  const servers = [
    ...demos.map((server) => ({ server })),
    ...base.servers,
  ].filter((entry) => {
    if (seen.has(entry.server.name)) {
      return false;
    }
    seen.add(entry.server.name);
    return true;
  });

  return {
    servers,
    metadata: {
      ...base.metadata,
      count: servers.length,
    },
  };
}

function validateRegistryName(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new BadRequestException('`registryName` must be a non-empty string.');
  }
  return value;
}

function validateKind(value: unknown): PluginKind {
  if (value === undefined) {
    return 'mcp';
  }
  if (value === 'mcp' || value === 'skill' || value === 'lsp') {
    return value;
  }
  throw new BadRequestException('`kind` must be mcp, skill, or lsp.');
}

function validateVersion(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new BadRequestException('`version` must be a non-empty string.');
  }
  return value;
}

function validateTrust(value: unknown): McpTrustLevel | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (
    typeof value !== 'string' ||
    !(TRUST_LEVELS as readonly string[]).includes(value)
  ) {
    throw new BadRequestException('`trust` must be trusted, ask, or blocked.');
  }
  return value as McpTrustLevel;
}

function validateEnabled(value: unknown): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'boolean') {
    throw new BadRequestException('`enabled` must be a boolean.');
  }
  return value;
}

@Injectable()
export class PluginsService {
  constructor(
    private readonly store: PluginStore,
    @Inject(PLUGIN_REGISTRY_CLIENT)
    private readonly registry: McpRegistryClient,
  ) {}

  async listRegistryServers(
    options: RegistryListOptions,
  ): Promise<McpRegistryListResponse> {
    try {
      const registry = await this.registry.listServers(options);
      if (options.cursor) {
        return registry;
      }
      return mergeRegistryServers(registry, listMcpCatalog());
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new BadGatewayException(message);
    }
  }

  async getRegistryServer(
    name: string,
    version?: string,
  ): Promise<McpRegistryServer> {
    const demo = findMcpCatalog(name);
    if (demo) {
      return demo;
    }
    try {
      return await this.registry.getServerVersion(name, version);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new BadGatewayException(message);
    }
  }

  listInstalled(): InstalledPlugin[] {
    return this.store.listInstalled();
  }

  listSkillRegistry() {
    return { plugins: listSkillCatalog() };
  }

  listLspRegistry() {
    return { plugins: listLspCatalog() };
  }

  async install(body: Record<string, unknown>): Promise<InstalledPlugin> {
    const kind = validateKind(body.kind);
    const registryName = validateRegistryName(body.registryName);
    const version = validateVersion(body.version);
    if (kind === 'skill') {
      const entry = findSkillCatalog(registryName);
      if (!entry || entry.kind !== 'skill') {
        throw new NotFoundException('Unknown skill plugin: ' + registryName);
      }
      return this.store.installCatalogPlugin({
        kind: 'skill',
        registryName: entry.name,
        title: entry.title,
        description: entry.description,
        version: entry.version,
        config: entry.config,
      });
    }

    if (kind === 'lsp') {
      const entry = findLspCatalog(registryName);
      if (!entry || entry.kind !== 'lsp') {
        throw new NotFoundException('Unknown LSP plugin: ' + registryName);
      }
      return this.store.installCatalogPlugin({
        kind: 'lsp',
        registryName: entry.name,
        title: entry.title,
        description: entry.description,
        version: entry.version,
        config: entry.config,
      });
    }

    const server = await this.getRegistryServer(registryName, version);

    let config;
    try {
      config = deriveMcpConfigFromRegistryServer(server);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new BadRequestException(message);
    }

    return this.store.installMcpPlugin({
      registryName: server.name,
      ...(server.title ? { title: server.title } : {}),
      ...(server.description ? { description: server.description } : {}),
      version: server.version ?? version ?? 'latest',
      config,
    });
  }

  update(id: string, body: Record<string, unknown>): InstalledPlugin {
    const enabled = validateEnabled(body.enabled);
    const trust = validateTrust(body.trust);
    if (enabled === undefined && trust === undefined) {
      throw new BadRequestException('Patch requires `enabled` or `trust`.');
    }

    try {
      return this.store.updateInstalled(id, {
        ...(enabled !== undefined ? { enabled } : {}),
        ...(trust !== undefined ? { trust } : {}),
      });
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Unknown')) {
        throw new NotFoundException(error.message);
      }
      if (
        error instanceof Error &&
        error.message === 'Trust can only be updated for MCP plugins.'
      ) {
        throw new BadRequestException(error.message);
      }
      throw error;
    }
  }

  delete(id: string): void {
    if (!this.store.deleteInstalled(id)) {
      throw new NotFoundException('Unknown installed plugin: ' + id);
    }
  }
}
