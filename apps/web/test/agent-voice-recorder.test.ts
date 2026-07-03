import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  appendTranscriptToDraft,
  floatToPcm16Base64,
} from '../app/agent/voice-recorder';

test('floatToPcm16Base64 clamps and encodes little-endian pcm16', () => {
  const encoded = floatToPcm16Base64(new Float32Array([-2, -0.5, 0, 0.5, 2]));
  const decoded = Buffer.from(encoded, 'base64');

  assert.deepEqual([...decoded], [
    0x00, 0x80, // -32768
    0x00, 0xc0, // -16384
    0x00, 0x00, // 0
    0xff, 0x3f, // 16383
    0xff, 0x7f, // 32767
  ]);
});

test('appendTranscriptToDraft separates transcript from existing draft without duplicating whitespace', () => {
  assert.equal(appendTranscriptToDraft('', '你好'), '你好');
  assert.equal(appendTranscriptToDraft('已有', ' 内容 '), '已有 内容');
  assert.equal(appendTranscriptToDraft('已有 ', '内容'), '已有 内容');
  assert.equal(appendTranscriptToDraft('已有', ''), '已有');
});
