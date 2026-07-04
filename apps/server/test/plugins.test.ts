import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { existsSync } from 'node:fs';
import { afterEach, test } from 'node:test';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import {
  deriveMcpConfigFromRegistryServer,
  PLUGIN_REGISTRY_CLIENT,
  type McpRegistryClient,
} from '../src/plugins/plugin-registry';
import { SdkMcpManager } from '@colorful-code/tool-runtime';
import {
  listMcpCatalog,
  listLspCatalog,
  listSkillCatalog,
} from '../src/plugins/plugin-catalog';
import { PluginStore } from '../src/plugins/plugin-store';
import { PluginsController } from '../src/plugins/plugins.controller';
import { PluginsService } from '../src/plugins/plugins.service';

const registryServer = {
  name: 'io.example/demo',
  title: 'Demo MCP',
  description: 'Demo server',
  version: '1.0.0',
  packages: [
    {
      registryType: 'npm',
      identifier: '@example/demo-mcp',
      version: '1.0.0',
      transport: { type: 'stdio' },
    },
  ],
};

const fakeRegistryClient: McpRegistryClient = {
  async listServers() {
    return {
      servers: [{ server: registryServer }],
      metadata: { count: 1 },
    };
  },
  async getServerVersion() {
    return registryServer;
  },
};

@Module({
  controllers: [PluginsController],
  providers: [
    PluginsService,
    { provide: PluginStore, useFactory: () => PluginStore.openAt(':memory:') },
    { provide: PLUGIN_REGISTRY_CLIENT, useValue: fakeRegistryClient },
  ],
})
class TestPluginsModule {}

let app: NestFastifyApplication | undefined;

async function boot(): Promise<NestFastifyApplication> {
  app = await NestFactory.create<NestFastifyApplication>(
    TestPluginsModule,
    new FastifyAdapter(),
    { logger: false },
  );
  await app.init();
  return app;
}

afterEach(async () => {
  if (app) {
    await app.close();
    app = undefined;
  }
});

test('deriveMcpConfigFromRegistryServer maps npm stdio packages to npx', () => {
  const config = deriveMcpConfigFromRegistryServer(registryServer);

  assert.deepEqual(config, {
    type: 'stdio',
    command: 'npx',
    args: ['-y', '@example/demo-mcp'],
    trust: 'ask',
  });
});

test('deriveMcpConfigFromRegistryServer maps pypi stdio packages to uvx', () => {
  const config = deriveMcpConfigFromRegistryServer({
    name: 'io.example/python-demo',
    version: '1.0.0',
    packages: [
      {
        registryType: 'pypi',
        identifier: 'demo-mcp',
        version: '1.0.0',
        transport: { type: 'stdio' },
      },
    ],
  });

  assert.deepEqual(config, {
    type: 'stdio',
    command: 'uvx',
    args: ['demo-mcp'],
    trust: 'ask',
  });
});

test('deriveMcpConfigFromRegistryServer accepts compact package metadata', () => {
  const config = deriveMcpConfigFromRegistryServer({
    name: 'io.example/compact-demo',
    version: '1.0.0',
    packages: [
      {
        registry: 'npm',
        name: '@example/compact-mcp',
        version: '1.0.0',
        transport: 'stdio',
      },
    ],
  });

  assert.deepEqual(config, {
    type: 'stdio',
    command: 'npx',
    args: ['-y', '@example/compact-mcp'],
    trust: 'ask',
  });
});

test('deriveMcpConfigFromRegistryServer maps remote streamable-http servers to http', () => {
  const config = deriveMcpConfigFromRegistryServer({
    name: 'ac.inference.sh/mcp',
    title: 'inference.sh',
    description: 'Run AI apps',
    version: '1.0.1',
    remotes: [
      {
        type: 'streamable-http',
        url: 'https://sh.inference.ac',
      },
    ],
  });

  assert.deepEqual(config, {
    type: 'http',
    url: 'https://sh.inference.ac',
    trust: 'ask',
  });
});

test('deriveMcpConfigFromRegistryServer maps package streamable-http transport to http', () => {
  const config = deriveMcpConfigFromRegistryServer({
    name: 'io.example/http-package',
    version: '1.0.0',
    packages: [
      {
        registryType: 'npm',
        identifier: '@example/http-mcp',
        version: '1.0.0',
        transport: {
          type: 'streamable-http',
          url: 'https://example.com/mcp',
        },
      },
    ],
  });

  assert.deepEqual(config, {
    type: 'http',
    url: 'https://example.com/mcp',
    trust: 'ask',
  });
});

test('deriveMcpConfigFromRegistryServer rejects unsupported packages', () => {
  assert.throws(
    () =>
      deriveMcpConfigFromRegistryServer({
        name: 'io.example/unsupported',
        version: '1.0.0',
        packages: [
          {
            registryType: 'oci',
            identifier: 'example',
            version: '1.0.0',
            transport: { type: 'stdio' },
          },
        ],
      }),
    /No supported MCP registry package found/,
  );
});

test('PluginStore persists installed plugins and updates enabled/trust fields', () => {
  const store = PluginStore.openAt(':memory:');
  try {
    const installed = store.installMcpPlugin({
      registryName: 'io.example/demo',
      title: 'Demo MCP',
      description: 'Demo server',
      version: '1.0.0',
      config: {
        type: 'stdio',
        command: 'npx',
        args: ['-y', '@example/demo-mcp'],
        trust: 'ask',
      },
    });

    assert.equal(store.listInstalled().length, 1);
    assert.equal(store.enabledMcpServers()['io-example-demo']?.trust, 'ask');

    const patched = store.updateInstalled(installed.id, {
      enabled: false,
      trust: 'trusted',
    });
    assert.equal(patched.enabled, false);
    assert.equal(patched.config.trust, 'trusted');
    assert.deepEqual(store.enabledMcpServers(), {});

    assert.equal(store.deleteInstalled(installed.id), true);
    assert.deepEqual(store.listInstalled(), []);
  } finally {
    store.close();
  }
});

test('PluginStore keeps enabled MCP server keys unique across registry namespaces', () => {
  const store = PluginStore.openAt(':memory:');
  try {
    const config = {
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@example/github-mcp'],
      trust: 'ask',
    } as const;
    store.installMcpPlugin({
      registryName: 'io.foo/github',
      version: '1.0.0',
      config,
    });
    store.installMcpPlugin({
      registryName: 'io.bar/github',
      version: '1.0.0',
      config,
    });

    assert.deepEqual(Object.keys(store.enabledMcpServers()).sort(), [
      'io-bar-github',
      'io-foo-github',
    ]);
  } finally {
    store.close();
  }
});

test('PluginStore keeps enabled LSP server keys unique across registry namespaces', () => {
  const store = PluginStore.openAt(':memory:');
  try {
    const config = {
      command: 'typescript-language-server',
      args: ['--stdio'],
      language: 'typescript',
      fileExtensions: ['.ts', '.tsx'],
    } as const;
    store.installCatalogPlugin({
      kind: 'lsp',
      registryName: 'io.foo/typescript',
      version: 'latest',
      config,
    });
    store.installCatalogPlugin({
      kind: 'lsp',
      registryName: 'io.bar/typescript',
      version: 'latest',
      config,
    });

    assert.deepEqual(Object.keys(store.enabledLspServers()).sort(), [
      'io-bar-typescript',
      'io-foo-typescript',
    ]);
  } finally {
    store.close();
  }
});

test('curated catalogs expose skill and LSP plugin entries', () => {
  assert.ok(
    listMcpCatalog().some((item) => item.name === 'colorful-code/demo-mcp'),
  );
  assert.ok(listSkillCatalog().some((item) => item.kind === 'skill'));
  assert.ok(listLspCatalog().some((item) => item.kind === 'lsp'));
});

test('PluginStore persists skill and LSP plugins separately', () => {
  const store = PluginStore.openAt(':memory:');
  try {
    const skill = store.installCatalogPlugin({
      kind: 'skill',
      registryName: 'github:colorful-code/skills/code-review',
      title: 'Code Review Skill',
      version: 'latest',
      config: {
        type: 'skill',
        source: 'github',
        repository: 'colorful-code/skills',
        path: 'code-review',
        entry: 'SKILL.md',
        installHint: 'Install into a configured skill root.',
      },
    });
    const lsp = store.installCatalogPlugin({
      kind: 'lsp',
      registryName: 'typescript-language-server',
      title: 'TypeScript LSP',
      version: 'latest',
      config: {
        command: 'typescript-language-server',
        args: ['--stdio'],
        language: 'typescript',
        fileExtensions: ['.ts', '.tsx', '.js', '.jsx'],
      },
    });

    assert.equal(skill.kind, 'skill');
    assert.equal(lsp.kind, 'lsp');
    assert.equal(
      store.enabledLspServers()['typescript-language-server']?.command,
      'typescript-language-server',
    );
  } finally {
    store.close();
  }
});

test('plugins API installs, lists, patches, and deletes MCP plugins', async () => {
  const app = await boot();
  const fastify = app.getHttpAdapter().getInstance();

  const registry = await fastify.inject({
    method: 'GET',
    url: '/plugins/registry/mcp?limit=10',
  });
  assert.equal(registry.statusCode, 200);
  assert.ok(
    registry
      .json<{ servers: Array<{ server: { name: string } }> }>()
      .servers.some((entry) => entry.server.name === 'io.example/demo'),
  );

  const install = await fastify.inject({
    method: 'POST',
    url: '/plugins/install',
    payload: { registryName: 'io.example/demo' },
  });
  assert.equal(install.statusCode, 201);
  const installed = install.json<{ id: string; enabled: boolean }>();
  assert.equal(installed.enabled, true);

  const list = await fastify.inject({
    method: 'GET',
    url: '/plugins/installed',
  });
  assert.equal(list.statusCode, 200);
  assert.equal(list.json<{ plugins: unknown[] }>().plugins.length, 1);

  const patch = await fastify.inject({
    method: 'PATCH',
    url: `/plugins/installed/${encodeURIComponent(installed.id)}`,
    payload: { enabled: false, trust: 'trusted' },
  });
  assert.equal(patch.statusCode, 200);
  assert.equal(patch.json<{ enabled: boolean }>().enabled, false);

  const deleted = await fastify.inject({
    method: 'DELETE',
    url: `/plugins/installed/${encodeURIComponent(installed.id)}`,
  });
  assert.equal(deleted.statusCode, 204);
});

test('plugins API lists and installs the built-in demo MCP without user-provided fields', async () => {
  const app = await boot();
  const fastify = app.getHttpAdapter().getInstance();

  const registry = await fastify.inject({
    method: 'GET',
    url: '/plugins/registry/mcp?limit=10',
  });
  assert.equal(registry.statusCode, 200);
  const demo = registry
    .json<{ servers: Array<{ server: { name: string; title?: string } }> }>()
    .servers.find((entry) => entry.server.name === 'colorful-code/demo-mcp');
  assert.ok(demo);
  assert.equal(demo.server.title, 'Colorful Code Demo MCP');

  const install = await fastify.inject({
    method: 'POST',
    url: '/plugins/install',
    payload: { registryName: 'colorful-code/demo-mcp' },
  });
  assert.equal(install.statusCode, 201);
  const installed = install.json<{
    kind: string;
    enabled: boolean;
    config: { type: string; command: string; args?: string[] };
  }>();
  assert.equal(installed.kind, 'mcp');
  assert.equal(installed.enabled, true);
  assert.equal(installed.config.type, 'stdio');
  assert.equal(installed.config.command, process.execPath);
  assert.ok(installed.config.args?.[0]);
  assert.equal(existsSync(installed.config.args[0]), true);
});

test('built-in demo MCP connects and serves the echo tool', async () => {
  const app = await boot();
  const fastify = app.getHttpAdapter().getInstance();

  const install = await fastify.inject({
    method: 'POST',
    url: '/plugins/install',
    payload: { registryName: 'colorful-code/demo-mcp' },
  });
  assert.equal(install.statusCode, 201);
  const installed = install.json<{
    config: ConstructorParameters<typeof SdkMcpManager>[0][string];
  }>();
  const manager = new SdkMcpManager({
    'colorful-code-demo-mcp': installed.config,
  });

  try {
    const connections = await manager.connectAll();
    const connection = connections[0];
    assert.equal(connection?.type, 'connected');
    assert.equal(
      connection?.type === 'connected' &&
        connection.tools.some((tool) => tool.name === 'echo'),
      true,
    );

    const result = await manager.callTool('colorful-code-demo-mcp', 'echo', {
      message: 'hello demo',
    });
    assert.match(JSON.stringify(result), /echo:hello demo/);
  } finally {
    await manager.close();
  }
});

test('plugins API lists and installs curated skill and LSP plugins', async () => {
  const app = await boot();
  const fastify = app.getHttpAdapter().getInstance();

  const skills = await fastify.inject({
    method: 'GET',
    url: '/plugins/registry/skills',
  });
  assert.equal(skills.statusCode, 200);
  const skillName = skills.json<{ plugins: Array<{ name: string }> }>()
    .plugins[0]?.name;
  assert.ok(skillName);

  const skillInstall = await fastify.inject({
    method: 'POST',
    url: '/plugins/install',
    payload: { kind: 'skill', registryName: skillName },
  });
  assert.equal(skillInstall.statusCode, 201);
  assert.equal(skillInstall.json<{ kind: string }>().kind, 'skill');

  const lsp = await fastify.inject({
    method: 'GET',
    url: '/plugins/registry/lsp',
  });
  assert.equal(lsp.statusCode, 200);
  const lspName = lsp.json<{ plugins: Array<{ name: string }> }>().plugins[0]
    ?.name;
  assert.ok(lspName);

  const lspInstall = await fastify.inject({
    method: 'POST',
    url: '/plugins/install',
    payload: { kind: 'lsp', registryName: lspName },
  });
  assert.equal(lspInstall.statusCode, 201);
  assert.equal(lspInstall.json<{ kind: string }>().kind, 'lsp');
});

test('plugins API rejects trust patches for non-MCP plugins with 400', async () => {
  const app = await boot();
  const fastify = app.getHttpAdapter().getInstance();

  const skills = await fastify.inject({
    method: 'GET',
    url: '/plugins/registry/skills',
  });
  assert.equal(skills.statusCode, 200);
  const skillName = skills.json<{ plugins: Array<{ name: string }> }>()
    .plugins[0]?.name;
  assert.ok(skillName);

  const install = await fastify.inject({
    method: 'POST',
    url: '/plugins/install',
    payload: { kind: 'skill', registryName: skillName },
  });
  assert.equal(install.statusCode, 201);
  const installed = install.json<{ id: string }>();

  const patch = await fastify.inject({
    method: 'PATCH',
    url: `/plugins/installed/${encodeURIComponent(installed.id)}`,
    payload: { trust: 'trusted' },
  });

  assert.equal(patch.statusCode, 400);
});
