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
  createScriptedModelClient([
    [
      {
        type: 'tool_use',
        toolUseId: 'mcp-call-1',
        name: 'mcp__fixture__echo',
        input: { message: 'from session' },
      },
    ],
    [{ type: 'text', text: 'MCP call completed.' }],
  ]);

@Module({
  controllers: [SessionsController],
  providers: [
    SessionsService,
    { provide: MODEL_CLIENT_FACTORY, useValue: scriptedFactory },
    { provide: SessionStore, useValue: SessionStore.openAt(':memory:') },
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

test('POST /sessions rejects malformed MCP config with 400', async () => {
  const app = await boot();
  const fastify = app.getHttpAdapter().getInstance();

  const badConfig = await fastify.inject({
    method: 'POST',
    url: '/sessions',
    payload: {
      mcpServers: {
        fixture: { type: 'stdio', args: ['missing command'] },
      },
    },
  });

  assert.equal(badConfig.statusCode, 400);
  assert.equal(app.get(SessionsService).has('session-1'), false);
});

test('session-created MCP tools are registered and callable by the model', async () => {
  const app = await boot();
  const fastify = app.getHttpAdapter().getInstance();
  const service = app.get(SessionsService);

  const createRes = await fastify.inject({
    method: 'POST',
    url: '/sessions',
    payload: {
      mcpServers: { fixture: fixtureServer },
    },
  });
  assert.equal(createRes.statusCode, 201);
  const { id } = createRes.json<{ id: string }>();

  service.submit(id, 'call the fixture MCP server');
  const result = await waitFor(
    service,
    id,
    (event) =>
      event.type === 'tool_result' &&
      event.toolUseId === 'mcp-call-1' &&
      event.content === 'echo:from session',
  );
  assert.equal(result.type, 'tool_result');

  const audit = await waitFor(
    service,
    id,
    (event) =>
      event.type === 'permission_decision' &&
      event.entry.toolName === 'mcp__fixture__echo',
  );
  assert.deepEqual(audit.type === 'permission_decision' && audit.entry.reason, {
    type: 'mcpTrust',
    server: 'fixture',
    trust: 'trusted',
  });

  const removed = await fastify.inject({
    method: 'DELETE',
    url: `/sessions/${id}`,
  });
  assert.equal(removed.statusCode, 204);
});

test('MCP trust ask emits approval metadata before running the tool', async () => {
  const app = await boot();
  const service = app.get(SessionsService);
  const { id } = await service.create({
    mcpServers: {
      fixture: { ...fixtureServer, trust: 'ask' },
    },
  });

  service.submit(id, 'call the fixture MCP server');
  const approval = await waitFor(
    service,
    id,
    (event) => event.type === 'approval_required',
  );

  assert.equal(approval.type, 'approval_required');
  assert.equal(
    approval.type === 'approval_required' && approval.name,
    'mcp__fixture__echo',
  );
  assert.deepEqual(approval.type === 'approval_required' && approval.source, {
    type: 'mcp',
    server: 'fixture',
  });
});

test('MCP trust blocked denies the tool call and audits the trust reason', async () => {
  const app = await boot();
  const service = app.get(SessionsService);
  const { id } = await service.create({
    mcpServers: {
      fixture: { ...fixtureServer, trust: 'blocked' },
    },
  });

  try {
    service.submit(id, 'call the fixture MCP server');
    const result = await waitFor(
      service,
      id,
      (event) =>
        event.type === 'tool_result' &&
        event.toolUseId === 'mcp-call-1' &&
        event.isError === true,
    );
    assert.match(
      result.type === 'tool_result' ? result.content : '',
      /blocked/,
    );

    const audit = await waitFor(
      service,
      id,
      (event) =>
        event.type === 'permission_decision' &&
        event.entry.toolName === 'mcp__fixture__echo',
    );
    assert.deepEqual(
      audit.type === 'permission_decision' && audit.entry.reason,
      { type: 'mcpTrust', server: 'fixture', trust: 'blocked' },
    );
  } finally {
    await service.dispose(id);
  }
});
