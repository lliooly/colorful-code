import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

test('agent chat surface does not render internal connection counters', () => {
  const source = readFileSync(
    new URL('../app/agent/page.tsx', import.meta.url),
    'utf8',
  );

  assert.doesNotMatch(source, /MCP ·/);
  assert.doesNotMatch(source, /LSP ·/);
  assert.doesNotMatch(source, /Events ·/);
});

test('agent page uses the desktop runtime store for desktop-only guards', () => {
  const source = readFileSync(
    new URL('../app/agent/page.tsx', import.meta.url),
    'utf8',
  );

  assert.doesNotMatch(source, /isDesktopRuntime/);
  assert.match(source, /desktopRuntime/);
});

test('agent page uses realtime voice transcription instead of browser speech recognition', () => {
  const source = readFileSync(
    new URL('../app/agent/page.tsx', import.meta.url),
    'utf8',
  );

  assert.doesNotMatch(source, /SpeechRecognition/);
  assert.doesNotMatch(source, /webkitSpeechRecognition/);
  assert.match(source, /startVoiceTranscription/);
  assert.match(source, /appendTranscriptToDraft/);
  assert.doesNotMatch(source, /voice_transcript_delta[\s\S]{0,240}handleSend/);
});
