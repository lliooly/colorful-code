import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { afterEach, test } from 'node:test';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import {
  createScriptedModelClient,
  type ModelClient,
  type ModelTurnInput,
  type ModelTurnEvent,
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
    { provide: SessionStore, useFactory: createTestSessionStore },
  ],
})
class TestAppModule {}

const countingFactory: ModelClientFactory = ({ sessionId }): ModelClient => ({
  run(input: ModelTurnInput): AsyncIterable<ModelTurnEvent> {
    return countingCompletion(
      `${sessionId} users=${String(
        input.history.filter((entry) => entry.role === 'user').length,
      )}`,
      input.signal,
    );
  },
});

const atomicRestoreFactory: ModelClientFactory = ({
  sessionId,
  selection,
}): ModelClient => {
  if (selection?.preset === 'explode') {
    throw new Error('model exploded');
  }
  return {
    run(input: ModelTurnInput): AsyncIterable<ModelTurnEvent> {
      return countingCompletion(
        `${sessionId} users=${String(
          input.history.filter((entry) => entry.role === 'user').length,
        )}`,
        input.signal,
      );
    },
  };
};

async function* countingCompletion(
  text: string,
  signal: AbortSignal,
): AsyncIterable<ModelTurnEvent> {
  if (!signal.aborted) {
    yield { type: 'text', text };
    yield { type: 'end' };
  }
}

@Module({
  controllers: [SessionsController],
  providers: [
    SessionsService,
    { provide: MODEL_CLIENT_FACTORY, useValue: countingFactory },
    { provide: SessionStore, useFactory: createTestSessionStore },
  ],
})
class CheckpointTestAppModule {}

@Module({
  controllers: [SessionsController],
  providers: [
    SessionsService,
    { provide: MODEL_CLIENT_FACTORY, useValue: atomicRestoreFactory },
    { provide: SessionStore, useFactory: createTestSessionStore },
  ],
})
class AtomicRestoreTestAppModule {}

let app: NestFastifyApplication | undefined;

afterEach(async () => {
  if (app) {
    await app.close();
    app = undefined;
  }
  await closeTestSessionStores();
  factoryCalls.clear();
});

async function boot(): Promise<NestFastifyApplication> {
  app = await NestFactory.create<NestFastifyApplication>(
    TestAppModule,
    new FastifyAdapter(),
    { logger: false },
  );
  await app.init();
  return app;
}

async function bootCheckpointApp(): Promise<NestFastifyApplication> {
  app = await NestFactory.create<NestFastifyApplication>(
    CheckpointTestAppModule,
    new FastifyAdapter(),
    { logger: false },
  );
  await app.init();
  return app;
}

async function bootAtomicRestoreApp(): Promise<NestFastifyApplication> {
  app = await NestFactory.create<NestFastifyApplication>(
    AtomicRestoreTestAppModule,
    new FastifyAdapter(),
    { logger: false },
  );
  await app.init();
  return app;
}

function userMessageCount(service: SessionsService, id: string): number {
  return (
    service.loadSnapshot(id)?.history.filter((entry) => entry.role === 'user')
      .length ?? 0
  );
}

async function submitAndWaitForMessage(
  service: SessionsService,
  id: string,
  text: string,
  expectedMessage: string,
): Promise<void> {
  const seen: SessionEvent[] = [];
  let sawExpectedMessage = false;
  let shouldUnsubscribe = false;
  let subscription: { unsubscribe(): void } | undefined;
  const completed = new Promise<void>((resolve, reject) => {
    subscription = service.events(id).subscribe({
      next(event) {
        seen.push(event);
        if (event.type === 'message' && event.content === expectedMessage) {
          sawExpectedMessage = true;
        }
        if (
          sawExpectedMessage &&
          event.type === 'run_status' &&
          event.status === 'completed'
        ) {
          if (subscription) {
            subscription.unsubscribe();
          } else {
            shouldUnsubscribe = true;
          }
          resolve();
        }
      },
      error(error) {
        subscription?.unsubscribe();
        reject(error);
      },
    });
    if (shouldUnsubscribe) {
      subscription.unsubscribe();
    }
  });

  service.submit(id, text);
  await completed;

  assert.ok(
    seen.some(
      (event) => event.type === 'message' && event.content === expectedMessage,
    ),
    `stream included assistant message: ${expectedMessage}`,
  );
}

test('POST /sessions/:id/restore rehydrates a snapshot and later submits stream events', async () => {
  const app = await boot();
  const fastify = app.getHttpAdapter().getInstance();
  const service = app.get(SessionsService);

  const { id } = await service.create();

  await submitAndWaitForMessage(
    service,
    id,
    'first message',
    `created live session ${id}`,
  );

  assert.ok(
    service.loadSnapshot(id),
    'first turn persisted a restorable snapshot',
  );
  assert.equal(
    await service.dispose(id),
    true,
    'dispose removes the live session',
  );
  assert.equal(service.has(id), false, 'disposed session is no longer live');

  const restoreRes = await fastify.inject({
    method: 'POST',
    url: `/sessions/${id}/restore`,
  });
  assert.equal(restoreRes.statusCode, 201, 'POST /restore rehydrates session');
  const expectedRestoredSession = {
    id,
    needsModelConfig: false,
    history: [
      { role: 'user', content: 'first message' },
      { role: 'assistant', content: `created live session ${id}` },
    ],
    permissionMode: 'default',
  };
  assert.deepEqual(restoreRes.json(), expectedRestoredSession);
  assert.equal(service.has(id), true, 'restore registers a live session entry');

  const duplicateRestoreRes = await fastify.inject({
    method: 'POST',
    url: `/sessions/${id}/restore`,
  });
  assert.equal(
    duplicateRestoreRes.statusCode,
    201,
    'restoring an already-live session is idempotent',
  );
  assert.deepEqual(duplicateRestoreRes.json(), expectedRestoredSession);
  assert.equal(
    factoryCalls.get(id),
    2,
    'idempotent restore does not build a duplicate live session',
  );

  await submitAndWaitForMessage(
    service,
    id,
    'second message',
    `restored live session ${id}`,
  );

  assert.equal(
    factoryCalls.get(id),
    2,
    'restore builds a new model client without storing model secrets in snapshot',
  );
});

test('checkpoint API can restore over a live session and fork an independent session', async () => {
  const app = await bootCheckpointApp();
  const fastify = app.getHttpAdapter().getInstance();
  const service = app.get(SessionsService);

  const { id } = await service.create();

  await submitAndWaitForMessage(service, id, 'first message', `${id} users=1`);
  await submitAndWaitForMessage(service, id, 'second message', `${id} users=2`);

  const checkpointsRes = await fastify.inject({
    method: 'GET',
    url: `/sessions/${id}/checkpoints`,
  });
  assert.equal(checkpointsRes.statusCode, 200, checkpointsRes.body);
  const listed = checkpointsRes.json() as {
    checkpoints: Array<{
      id: string;
      runId: string;
      parentCheckpointId?: string;
    }>;
    currentCheckpointId?: string;
  };
  assert.equal(
    listed.checkpoints.length,
    2,
    'one checkpoint per completed run',
  );
  assert.equal(listed.checkpoints[0]?.runId, `${id}-run-1`);
  assert.equal(
    listed.checkpoints[1]?.parentCheckpointId,
    listed.checkpoints[0]?.id,
    'later checkpoint points at the previous checkpoint',
  );
  assert.equal(
    listed.currentCheckpointId,
    listed.checkpoints[1]?.id,
    'latest saved checkpoint is marked current',
  );

  const firstCheckpointId = listed.checkpoints[0]!.id;
  const restoreRes = await fastify.inject({
    method: 'POST',
    url: `/sessions/${id}/checkpoints/${firstCheckpointId}/restore`,
  });
  assert.equal(restoreRes.statusCode, 201);
  assert.deepEqual(restoreRes.json(), {
    id,
    checkpointId: firstCheckpointId,
    needsModelConfig: false,
    history: [
      { role: 'user', content: 'first message' },
      { role: 'assistant', content: `${id} users=1` },
    ],
    permissionMode: 'default',
  });
  assert.equal(
    userMessageCount(service, id),
    1,
    'restoring a checkpoint immediately updates the persisted live snapshot',
  );

  await submitAndWaitForMessage(service, id, 'after restore', `${id} users=2`);

  const forkRes = await fastify.inject({
    method: 'POST',
    url: `/sessions/${id}/checkpoints/${firstCheckpointId}/fork`,
  });
  assert.equal(forkRes.statusCode, 201);
  const forked = forkRes.json() as { id: string; checkpointId: string };
  assert.notEqual(forked.id, id, 'fork creates a new session id');
  assert.equal(
    service.loadSnapshot(forked.id)?.id,
    forked.id,
    'fork immediately persists a latest snapshot for the new session',
  );
  assert.equal(
    userMessageCount(service, forked.id),
    1,
    'fork latest snapshot starts from the source checkpoint history',
  );
  assert.equal(
    forked.checkpointId,
    firstCheckpointId,
    'response identifies the source checkpoint',
  );

  await submitAndWaitForMessage(
    service,
    forked.id,
    'fork follow-up',
    `${forked.id} users=2`,
  );
  await submitAndWaitForMessage(
    service,
    id,
    'original follow-up',
    `${id} users=3`,
  );

  const forkCheckpointsRes = await fastify.inject({
    method: 'GET',
    url: `/sessions/${forked.id}/checkpoints`,
  });
  assert.equal(forkCheckpointsRes.statusCode, 200);
  const forkListed = forkCheckpointsRes.json() as {
    checkpoints: Array<{ parentCheckpointId?: string }>;
  };
  assert.equal(
    forkListed.checkpoints[0]?.parentCheckpointId,
    firstCheckpointId,
    'fork session starts with a checkpoint linked to its source checkpoint',
  );
});

test('failed checkpoint restore leaves the current live session usable', async () => {
  const app = await bootAtomicRestoreApp();
  const fastify = app.getHttpAdapter().getInstance();
  const service = app.get(SessionsService);

  const { id } = await service.create();

  await submitAndWaitForMessage(service, id, 'first message', `${id} users=1`);
  await submitAndWaitForMessage(service, id, 'second message', `${id} users=2`);

  const { checkpoints } = (await fastify
    .inject({
      method: 'GET',
      url: `/sessions/${id}/checkpoints`,
    })
    .then((res) => res.json())) as {
    checkpoints: Array<{ id: string }>;
  };
  const firstCheckpointId = checkpoints[0]!.id;

  const restoreRes = await fastify.inject({
    method: 'POST',
    url: `/sessions/${id}/checkpoints/${firstCheckpointId}/restore`,
    payload: { model: { preset: 'explode' } },
  });
  assert.notEqual(
    restoreRes.statusCode,
    201,
    'the restore request fails before swapping the live session',
  );
  assert.equal(service.has(id), true, 'the original live session is preserved');

  await submitAndWaitForMessage(
    service,
    id,
    'after failed restore',
    `${id} users=3`,
  );
});
