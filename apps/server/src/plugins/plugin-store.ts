import { Inject, Injectable } from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';
import type {
  McpServerConfigWithTrust,
  McpServersConfig,
} from '../config/mcp-config';
import type { LspServersConfig } from '../config/lsp-config';
import {
  type DatabaseConnection,
  type DatabaseProvider,
  type SynchronousTransactionResult,
} from '../persistence/database-provider';
import { DATABASE_PROVIDER } from '../persistence/database-provider.module';
import type { WriteDatabaseConnection } from '../persistence/database-clock';
import {
  installedPlugins,
  type InstalledPluginRow,
} from '../persistence/schema';
import type {
  InstalledPlugin,
  InstalledPluginConfig,
  InstalledPluginPatch,
  InstallCatalogPluginInput,
  InstallMcpPluginInput,
  LspPluginConfig,
} from './plugin-types';

function pluginId(kind: string, registryName: string): string {
  return kind + ':' + registryName;
}

function serverName(registryName: string): string {
  return registryName
    .replace(/[^a-zA-Z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function isLspPluginConfig(
  config: InstalledPluginConfig,
): config is LspPluginConfig {
  return (
    typeof (config as { command?: unknown }).command === 'string' &&
    typeof (config as { language?: unknown }).language === 'string' &&
    Array.isArray((config as { fileExtensions?: unknown }).fileExtensions)
  );
}

@Injectable()
export class PluginStore {
  constructor(
    @Inject(DATABASE_PROVIDER) private readonly provider: DatabaseProvider,
  ) {}

  private read<T>(operation: (database: DatabaseConnection['db']) => T): T {
    return this.provider.read((connection) => operation(connection.db));
  }

  private write<T>(
    operation: (database: WriteDatabaseConnection['db'], now: number) => T,
  ): Promise<T> {
    return this.provider.transaction<T>(
      (transaction) =>
        operation(
          transaction.database.db,
          transaction.now,
        ) as SynchronousTransactionResult<T>,
    );
  }

  installMcpPlugin(input: InstallMcpPluginInput): Promise<InstalledPlugin> {
    return this.write((database, now) => {
      const existing = this.loadFrom(
        database,
        pluginId('mcp', input.registryName),
      );
      const existingMcpConfig =
        existing?.kind === 'mcp'
          ? (existing.config as McpServerConfigWithTrust)
          : undefined;
      return this.installRow(database, now, {
        kind: 'mcp',
        registryName: input.registryName,
        title: input.title,
        description: input.description,
        version: input.version,
        enabled: existing?.enabled,
        installedAt: existing?.installedAt,
        config: {
          ...input.config,
          trust: input.config.trust ?? existingMcpConfig?.trust ?? 'ask',
        },
      });
    });
  }

  installCatalogPlugin(
    input: InstallCatalogPluginInput,
  ): Promise<InstalledPlugin> {
    return this.write((database, now) => {
      const existing = this.loadFrom(
        database,
        pluginId(input.kind, input.registryName),
      );
      return this.installRow(database, now, {
        kind: input.kind,
        registryName: input.registryName,
        title: input.title,
        description: input.description,
        version: input.version,
        enabled: existing?.enabled,
        installedAt: existing?.installedAt,
        config: input.config,
      });
    });
  }

  private installRow(
    database: WriteDatabaseConnection['db'],
    now: number,
    input: {
      kind: InstalledPlugin['kind'];
      registryName: string;
      title?: string;
      description?: string;
      version: string;
      enabled?: boolean;
      installedAt?: number;
      config: InstalledPluginConfig;
    },
  ): InstalledPlugin {
    const row = {
      id: pluginId(input.kind, input.registryName),
      kind: input.kind,
      registryName: input.registryName,
      title: input.title ?? null,
      description: input.description ?? null,
      version: input.version,
      enabled: input.enabled === false ? 0 : 1,
      config: JSON.stringify(input.config),
      installedAt: input.installedAt ?? now,
      updatedAt: now,
    };

    database
      .insert(installedPlugins)
      .values(row)
      .onConflictDoUpdate({
        target: installedPlugins.id,
        set: {
          kind: row.kind,
          registryName: row.registryName,
          title: row.title,
          description: row.description,
          version: row.version,
          enabled: row.enabled,
          config: row.config,
          installedAt: row.installedAt,
          updatedAt: row.updatedAt,
        },
      })
      .run();

    return this.toInstalledPlugin(row);
  }

  listInstalled(): InstalledPlugin[] {
    return this.read((database) =>
      database
        .select()
        .from(installedPlugins)
        .orderBy(asc(installedPlugins.registryName))
        .all(),
    ).map((row) => this.toInstalledPlugin(row));
  }

  load(id: string): InstalledPlugin | undefined {
    return this.read((database) => this.loadFrom(database, id));
  }

  private loadFrom(
    database: DatabaseConnection['db'] | WriteDatabaseConnection['db'],
    id: string,
  ): InstalledPlugin | undefined {
    const rows = database
      .select()
      .from(installedPlugins)
      .where(eq(installedPlugins.id, id))
      .limit(1)
      .all();
    const row = rows[0];
    return row ? this.toInstalledPlugin(row) : undefined;
  }

  updateInstalled(
    id: string,
    patch: InstalledPluginPatch,
  ): Promise<InstalledPlugin> {
    return this.write((database, now) => {
      const current = this.loadFrom(database, id);
      if (!current) {
        throw new Error('Unknown installed plugin: ' + id);
      }

      if (patch.trust && current.kind !== 'mcp') {
        throw new Error('Trust can only be updated for MCP plugins.');
      }

      const config: InstalledPluginConfig =
        patch.trust && current.kind === 'mcp'
          ? {
              ...(current.config as McpServerConfigWithTrust),
              trust: patch.trust,
            }
          : current.config;

      database
        .update(installedPlugins)
        .set({
          ...(patch.enabled !== undefined
            ? { enabled: patch.enabled ? 1 : 0 }
            : {}),
          config: JSON.stringify(config),
          updatedAt: now,
        })
        .where(eq(installedPlugins.id, id))
        .run();

      return {
        ...current,
        enabled: patch.enabled ?? current.enabled,
        config,
        updatedAt: now,
      };
    });
  }

  deleteInstalled(id: string): Promise<boolean> {
    return this.write((database) => {
      const existing = this.loadFrom(database, id);
      if (!existing) return false;
      database
        .delete(installedPlugins)
        .where(eq(installedPlugins.id, id))
        .run();
      return true;
    });
  }

  enabledMcpServers(): McpServersConfig {
    const servers: McpServersConfig = {};
    for (const plugin of this.listInstalled()) {
      if (plugin.kind !== 'mcp' || !plugin.enabled) {
        continue;
      }
      servers[serverName(plugin.registryName)] =
        plugin.config as McpServerConfigWithTrust;
    }
    return servers;
  }

  enabledLspServers(): LspServersConfig {
    const servers: LspServersConfig = {};
    for (const plugin of this.listInstalled()) {
      if (
        plugin.kind !== 'lsp' ||
        !plugin.enabled ||
        !isLspPluginConfig(plugin.config)
      ) {
        continue;
      }
      servers[serverName(plugin.registryName)] = plugin.config;
    }
    return servers;
  }

  private toInstalledPlugin(row: InstalledPluginRow): InstalledPlugin {
    return {
      id: row.id,
      kind: row.kind as InstalledPlugin['kind'],
      registryName: row.registryName,
      ...(row.title !== null ? { title: row.title } : {}),
      ...(row.description !== null ? { description: row.description } : {}),
      version: row.version,
      enabled: row.enabled === 1,
      config: JSON.parse(row.config) as InstalledPluginConfig,
      installedAt: row.installedAt,
      updatedAt: row.updatedAt,
    };
  }
}
