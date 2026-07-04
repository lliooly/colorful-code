import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import {
  createScriptedModelClient,
  type ModelClient,
  type SessionEvent,
} from '@colorful-code/tool-runtime';
import { PluginStore } from '../src/plugins/plugin-store';
import { SessionsController } from '../src/sessions/sessions.controller';
import { SessionsService } from '../src/sessions/sessions.service';
import {
  MODEL_CLIENT_FACTORY,
  type ModelClientFactory,
} from '../src/sessions/model-factory';
import { SessionStore } from '../src/persistence/session-store';

const fixtureServer = {
  type: 'stdio',
  command: process.execPath,
  args: [
    join(
      process.cwd(),
      '../../packages/tool-runtime/src/__tests__/fixtures/mcp-stdio-server.mjs',
    ),
  ],
  trust: 'trusted',
} as const;

const scriptedFactory: ModelClientFactory = (): ModelClient =>
  createScriptedModelClient([[{ type: 'text', text: 'Ready.' }]]);

@Module({
  controllers: [SessionsController],
  providers: [
    SessionsService,
    { provide: MODEL_CLIENT_FACTORY, useValue: scriptedFactory },
    {
      provide: SessionStore,
      useFactory: () => SessionStore.openAt(':memory:'),
    },
    { provide: PluginStore, useFactory: () => PluginStore.openAt(':memory:') },
  ],
})
class TestAppModule {}

let app: NestFastifyApplication | undefined;

async function boot(): Promise<NestFastifyApplication> {
  app = await NestFactory.create<NestFastifyApplication>(
    TestAppModule,
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

async function waitFor(
  service: SessionsService,
  id: string,
  predicate: (event: SessionEvent) => boolean,
): Promise<SessionEvent> {
  const seen: SessionEvent[] = [];
  const subscription = service.events(id).subscribe((event) => {
    seen.push(event);
  });
  try {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const match = seen.find(predicate);
      if (match) {
        return match;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.fail('timed out waiting for expected session event');
  } finally {
    subscription.unsubscribe();
  }
}

async function collectReplay(
  service: SessionsService,
  id: string,
): Promise<SessionEvent[]> {
  const seen: SessionEvent[] = [];
  const subscription = service.events(id).subscribe((event) => {
    seen.push(event);
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  subscription.unsubscribe();
  return seen;
}

test('sessions merge enabled installed MCP plugins', async () => {
  const app = await boot();
  const pluginStore = app.get(PluginStore);
  const service = app.get(SessionsService);

  pluginStore.installMcpPlugin({
    registryName: 'io.example/fixture',
    title: 'Fixture',
    version: '1.0.0',
    config: fixtureServer,
  });

  const { id } = await service.create();
  const status = await waitFor(
    service,
    id,
    (event) => event.type === 'mcp_status',
  );

  assert.equal(
    status.type === 'mcp_status' && status.servers[0]?.name,
    'io-example-fixture',
  );
  assert.equal(
    status.type === 'mcp_status' && status.servers[0]?.status,
    'connected',
  );
});

test('sessions exclude disabled installed MCP plugins', async () => {
  const app = await boot();
  const pluginStore = app.get(PluginStore);
  const service = app.get(SessionsService);

  const installed = pluginStore.installMcpPlugin({
    registryName: 'io.example/fixture',
    title: 'Fixture',
    version: '1.0.0',
    config: fixtureServer,
  });
  pluginStore.updateInstalled(installed.id, { enabled: false });

  const { id } = await service.create();
  const entry = (await collectReplay(service, id)).find(
    (event) => event.type === 'mcp_status',
  );

  assert.equal(entry, undefined);
});

test('sessions report failed installed MCP plugins instead of hiding them', async () => {
  const app = await boot();
  const pluginStore = app.get(PluginStore);
  const service = app.get(SessionsService);

  pluginStore.installMcpPlugin({
    registryName: 'io.example/broken',
    title: 'Broken MCP',
    version: '1.0.0',
    config: {
      type: 'stdio',
      command: process.execPath,
      args: ['--definitely-not-an-mcp-server'],
      trust: 'ask',
    },
  });

  const { id } = await service.create();
  const status = await waitFor(
    service,
    id,
    (event) => event.type === 'mcp_status',
  );

  assert.equal(
    status.type === 'mcp_status' && status.servers[0]?.name,
    'io-example-broken',
  );
  assert.equal(
    status.type === 'mcp_status' && status.servers[0]?.status,
    'failed',
  );
  assert.match(
    status.type === 'mcp_status' ? (status.servers[0]?.error ?? '') : '',
    /connect|closed|failed|exit|Unexpected/i,
  );
});

test('sessions merge enabled installed LSP plugins', async () => {
  const app = await boot();
  const pluginStore = app.get(PluginStore);
  const service = app.get(SessionsService);

  pluginStore.installCatalogPlugin({
    kind: 'lsp',
    registryName: 'test-lsp',
    title: 'Test LSP',
    version: 'latest',
    config: {
      command: process.execPath,
      args: ['--definitely-not-an-lsp'],
      language: 'test',
      fileExtensions: ['.test'],
    },
  });

  const { id } = await service.create();
  const status = await waitFor(
    service,
    id,
    (event) => event.type === 'lsp_status',
  );

  assert.equal(
    status.type === 'lsp_status' && status.servers[0]?.name,
    'test-lsp',
  );
  assert.equal(
    status.type === 'lsp_status' && status.servers[0]?.language,
    'test',
  );
});

test('sessions exclude disabled installed LSP plugins', async () => {
  const app = await boot();
  const pluginStore = app.get(PluginStore);
  const service = app.get(SessionsService);

  const installed = pluginStore.installCatalogPlugin({
    kind: 'lsp',
    registryName: 'test-lsp',
    title: 'Test LSP',
    version: 'latest',
    config: {
      command: process.execPath,
      args: ['--definitely-not-an-lsp'],
      language: 'test',
      fileExtensions: ['.test'],
    },
  });
  pluginStore.updateInstalled(installed.id, { enabled: false });

  const { id } = await service.create();
  const entry = (await collectReplay(service, id)).find(
    (event) => event.type === 'lsp_status',
  );

  assert.equal(entry, undefined);
});
