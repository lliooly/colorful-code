import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  createScriptedModelClient,
  type SessionEvent,
} from '@colorful-code/tool-runtime';
import { ModelSelectionError } from '../src/sessions/model-factory';
import { SessionsService } from '../src/sessions/sessions.service';
import {
  closeTestSessionStores,
  createTestSessionStore,
} from './support/test-session-store';

test('submit emits a model-config error correlated to the session when no run starts', async () => {
  const store = createTestSessionStore();
  const service = new SessionsService(() => {
    throw new ModelSelectionError('No API key configured for test model.');
  }, store);

  const { id, needsModelConfig } = await service.create();
  assert.equal(needsModelConfig, true);

  const seen: SessionEvent[] = [];
  const subscription = service.events(id).subscribe((event) => {
    seen.push(event);
  });

  try {
    service.submit(id, 'Hello');

    const error = seen.find((event) => event.type === 'error');
    assert.ok(error, 'missing model-config error event');
    assert.equal(error.runId, id);
    assert.match(error.message, /No API key configured/);
  } finally {
    subscription.unsubscribe();
    await service.dispose(id);
    await service.onModuleDestroy();
    await closeTestSessionStores();
  }
});

test('configureModel replaces the client used by an already configured session', async () => {
  const store = createTestSessionStore();
  const service = new SessionsService(
    ({ selection }) =>
      createScriptedModelClient([
        [
          {
            type: 'text',
            text: selection?.model === 'new-model' ? 'new' : 'old',
          },
        ],
      ]),
    store,
  );
  const { id } = await service.create();
  service.configureModel(id, {
    preset: 'openai',
    apiKey: 'request-key',
    model: 'new-model',
  });
  const seen: SessionEvent[] = [];
  const completed = new Promise<void>((resolve) => {
    service.events(id).subscribe((event) => {
      seen.push(event);
      if (event.type === 'run_status' && event.status === 'completed')
        resolve();
    });
  });
  service.submit(id, 'Hello');
  await completed;
  assert.ok(
    seen.some((event) => event.type === 'message' && event.content === 'new'),
  );
  await service.dispose(id);
  await service.onModuleDestroy();
  await closeTestSessionStores();
});

test('dispose skips final persistence after the store has already closed', async () => {
  const store = createTestSessionStore();
  const service = new SessionsService(
    () => createScriptedModelClient([[{ type: 'text', text: 'ok' }]]),
    store,
  );
  const { id } = await service.create();
  const errors: unknown[][] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => errors.push(args);
  try {
    store.close();
    await service.dispose(id);
    assert.deepEqual(errors, []);
  } finally {
    console.error = originalError;
    await closeTestSessionStores();
  }
});

test('failed audit append remains pending and succeeds exactly once on retry', async () => {
  const store = createTestSessionStore();
  const service = new SessionsService(
    () => createScriptedModelClient([[{ type: 'text', text: 'ok' }]]),
    store,
  );
  const { id } = await service.create();
  const entry = (
    service as unknown as {
      entries: Map<
        string,
        {
          session: { snapshot(): unknown };
          pendingAudit: Array<{
            toolUseId: string;
            toolName: string;
            behavior: 'allow';
            at: number;
          }>;
        }
      >;
    }
  ).entries.get(id)!;
  entry.pendingAudit.push({
    toolUseId: 'retry-call',
    toolName: 'Read',
    behavior: 'allow',
    at: 1,
  });
  const appendAudit = store.appendAudit.bind(store);
  let attempts = 0;
  store.appendAudit = async (sessionId, entries) => {
    attempts += 1;
    if (attempts === 1) throw new Error('injected audit failure');
    await appendAudit(sessionId, entries);
  };
  const persist = (
    service as unknown as {
      persist(session: unknown, pending: unknown[]): Promise<void>;
    }
  ).persist.bind(service);
  const originalError = console.error;
  console.error = () => undefined;
  try {
    await persist(entry.session, entry.pendingAudit);
    assert.equal(entry.pendingAudit.length, 1);
    await persist(entry.session, entry.pendingAudit);
    assert.equal(entry.pendingAudit.length, 0);
    assert.equal(store.listAudit(id).length, 1);
  } finally {
    console.error = originalError;
    await service.dispose(id);
    await service.onModuleDestroy();
    await closeTestSessionStores();
  }
});
