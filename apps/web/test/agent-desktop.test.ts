import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { isTauriRuntime } from '../app/agent/desktop';

test('isTauriRuntime is false without the Tauri bridge', () => {
  assert.equal(isTauriRuntime({}), false);
});

test('isTauriRuntime is true when the Tauri bridge is present', () => {
  assert.equal(
    isTauriRuntime({
      __TAURI_INTERNALS__: {},
    }),
    true,
  );
});
