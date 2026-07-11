import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { createScriptedModelClient, type SessionEvent } from '@colorful-code/tool-runtime';
import { SessionStore } from '../src/persistence/session-store';
import { ModelSelectionError } from '../src/sessions/model-factory';
import { SessionsService } from '../src/sessions/sessions.service';

test('submit emits a model-config error correlated to the session when no run starts', async () => {
  const service = new SessionsService(
    () => {
      throw new ModelSelectionError('No API key configured for test model.');
    },
    SessionStore.openAt(':memory:'),
  );

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
    service.onModuleDestroy();
  }
});

test('configureModel replaces the client used by an already configured session', async () => {
  const service = new SessionsService(
    ({ selection }) =>
      createScriptedModelClient([
        [{ type: 'text', text: selection?.model === 'new-model' ? 'new' : 'old' }],
      ]),
    SessionStore.openAt(':memory:'),
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
      if (event.type === 'run_status' && event.status === 'completed') resolve();
    });
  });
  service.submit(id, 'Hello');
  await completed;
  assert.ok(seen.some((event) => event.type === 'message' && event.content === 'new'));
  await service.dispose(id);
  service.onModuleDestroy();
});
