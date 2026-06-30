import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { afterEach, test } from 'node:test';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  NestFastifyApplication
} from '@nestjs/platform-fastify';
import {
  createScriptedModelClient,
  type ModelClient,
  type SessionEvent
} from '@colorful-code/tool-runtime';
import { SessionsController } from '../src/sessions/sessions.controller';
import { SessionsService } from '../src/sessions/sessions.service';
import {
  MODEL_CLIENT_FACTORY,
  type ModelClientFactory
} from '../src/sessions/model-factory';
import { SessionStore } from '../src/persistence/session-store';

const factoryCalls = new Map<string, number>();

const scriptedFactory: ModelClientFactory = ({ sessionId }): ModelClient => {
  const call = (factoryCalls.get(sessionId) ?? 0) + 1;
  factoryCalls.set(sessionId, call);
  const text =
    call === 1
      ? `created live session ${sessionId}`
      : `restored live session ${sessionId}`;
  return createScriptedModelClient([[{ type: 'text', text }]]);
};

@Module({
  controllers: [SessionsController],
  providers: [
    SessionsService,
    { provide: MODEL_CLIENT_FACTORY, useValue: scriptedFactory },
    { provide: SessionStore, useValue: SessionStore.openAt(':memory:') }
  ]
})
class TestAppModule {}

let app: NestFastifyApplication | undefined;

afterEach(async () => {
  if (app) {
    await app.close();
    app = undefined;
  }
  factoryCalls.clear();
});

async function boot(): Promise<NestFastifyApplication> {
  app = await NestFactory.create<NestFastifyApplication>(
    TestAppModule,
    new FastifyAdapter(),
    { logger: false }
  );
  await app.init();
  return app;
}

async function submitAndWaitForMessage(
  service: SessionsService,
  id: string,
  text: string,
  expectedMessage: string
): Promise<void> {
  const seen: SessionEvent[] = [];
  const completed = new Promise<void>((resolve, reject) => {
    const subscription = service.events(id).subscribe({
      next(event) {
        seen.push(event);
        if (event.type === 'run_status' && event.status === 'completed') {
          subscription.unsubscribe();
          resolve();
        }
      },
      error(error) {
        subscription.unsubscribe();
        reject(error);
      }
    });
  });

  service.submit(id, text);
  await completed;

  assert.ok(
    seen.some(
      (event) => event.type === 'message' && event.content === expectedMessage
    ),
    `stream included assistant message: ${expectedMessage}`
  );
}

test('POST /sessions/:id/restore rehydrates a snapshot and later submits stream events', async () => {
  const app = await boot();
  const fastify = app.getHttpAdapter().getInstance();
  const service = app.get(SessionsService);

  const { id } = service.create();

  await submitAndWaitForMessage(
    service,
    id,
    'first message',
    `created live session ${id}`
  );

  assert.ok(
    service.loadSnapshot(id),
    'first turn persisted a restorable snapshot'
  );
  assert.equal(service.dispose(id), true, 'dispose removes the live session');
  assert.equal(service.has(id), false, 'disposed session is no longer live');

  const restoreRes = await fastify.inject({
    method: 'POST',
    url: `/sessions/${id}/restore`
  });
  assert.equal(restoreRes.statusCode, 201, 'POST /restore rehydrates session');
  assert.deepEqual(restoreRes.json(), { id });
  assert.equal(service.has(id), true, 'restore registers a live session entry');

  const duplicateRestoreRes = await fastify.inject({
    method: 'POST',
    url: `/sessions/${id}/restore`
  });
  assert.equal(
    duplicateRestoreRes.statusCode,
    201,
    'restoring an already-live session is idempotent'
  );
  assert.deepEqual(duplicateRestoreRes.json(), { id });
  assert.equal(
    factoryCalls.get(id),
    2,
    'idempotent restore does not build a duplicate live session'
  );

  await submitAndWaitForMessage(
    service,
    id,
    'second message',
    `restored live session ${id}`
  );

  assert.equal(
    factoryCalls.get(id),
    2,
    'restore builds a new model client without storing model secrets in snapshot'
  );
});
