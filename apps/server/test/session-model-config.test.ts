import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { SessionEvent } from '@colorful-code/tool-runtime';
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
