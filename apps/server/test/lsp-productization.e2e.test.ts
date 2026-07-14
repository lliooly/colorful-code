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
import {
  closeTestSessionStores,
  createTestSessionStore,
} from './support/test-session-store';

const fixtureServer = {
  command: process.execPath,
  args: [
    join(
      process.cwd(),
      '../../packages/tool-runtime/src/__tests__/fixtures/lsp-stdio-server.mjs',
    ),
  ],
  language: 'typescript',
  fileExtensions: ['.ts'],
} as const;

const scriptedFactory: ModelClientFactory = (): ModelClient =>
  createScriptedModelClient([
    [
      {
        type: 'tool_use',
        toolUseId: 'lsp-call-1',
        name: 'LSPGoToDefinition',
        input: {
          file: join(process.cwd(), 'test/sample.ts'),
          line: 0,
          character: 1,
        },
      },
    ],
    [{ type: 'text', text: 'LSP call completed.' }],
  ]);

@Module({
  controllers: [SessionsController],
  providers: [
    SessionsService,
    { provide: MODEL_CLIENT_FACTORY, useValue: scriptedFactory },
    { provide: SessionStore, useFactory: createTestSessionStore },
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
  await closeTestSessionStores();
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

test('POST /sessions rejects malformed LSP config with 400', async () => {
  const app = await boot();
  const fastify = app.getHttpAdapter().getInstance();

  const badConfig = await fastify.inject({
    method: 'POST',
    url: '/sessions',
    payload: {
      lspServers: {
        fixture: {
          command: '',
          language: 'typescript',
          fileExtensions: ['.ts'],
        },
      },
    },
  });

  assert.equal(badConfig.statusCode, 400);
});

test('session-created LSP tools are registered and callable by the model', async () => {
  const app = await boot();
  const fastify = app.getHttpAdapter().getInstance();
  const service = app.get(SessionsService);

  const createRes = await fastify.inject({
    method: 'POST',
    url: '/sessions',
    payload: {
      cwd: process.cwd(),
      lspServers: { fixture: fixtureServer },
    },
  });
  assert.equal(createRes.statusCode, 201);
  const { id } = createRes.json<{ id: string }>();

  const status = await waitFor(
    service,
    id,
    (event) => event.type === 'lsp_status',
  );
  assert.deepEqual(status.type === 'lsp_status' && status.servers[0], {
    name: 'fixture',
    language: 'typescript',
    fileExtensions: ['.ts'],
    status: 'connected',
  });

  service.submit(id, 'call the fixture LSP server');
  const call = await waitFor(
    service,
    id,
    (event) =>
      event.type === 'tool_call' &&
      event.toolUseId === 'lsp-call-1' &&
      event.source?.type === 'lsp',
  );
  assert.equal(call.type, 'tool_call');

  const result = await waitFor(
    service,
    id,
    (event) =>
      event.type === 'tool_result' &&
      event.toolUseId === 'lsp-call-1' &&
      event.content.includes('sample.ts:3:8'),
  );
  assert.equal(result.type, 'tool_result');
  assert.deepEqual(result.type === 'tool_result' && result.source, {
    type: 'lsp',
  });

  const removed = await fastify.inject({
    method: 'DELETE',
    url: `/sessions/${id}`,
  });
  assert.equal(removed.statusCode, 204);
});
