import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  canUseBrowserSpeechRecognition,
  canUseMacosSpeech,
  isTauriRuntime,
} from '../app/agent/desktop';

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

test('browser speech recognition is disabled inside Tauri', () => {
  assert.equal(
    canUseBrowserSpeechRecognition({
      __TAURI_INTERNALS__: {},
      webkitSpeechRecognition: function SpeechRecognition() {},
    }),
    false,
  );
});

test('browser speech recognition is available in regular browsers', () => {
  assert.equal(
    canUseBrowserSpeechRecognition({
      webkitSpeechRecognition: function SpeechRecognition() {},
    }),
    true,
  );
});

test('macOS native speech is only available inside Tauri', () => {
  assert.equal(canUseMacosSpeech({}), false);
  assert.equal(canUseMacosSpeech({ __TAURI_INTERNALS__: {} }), true);
});
