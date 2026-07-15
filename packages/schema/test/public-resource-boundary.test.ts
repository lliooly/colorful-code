import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { z } from 'zod';
import {
  operationViewSchema,
  approvalViewSchema,
  toolExecutionSummarySchema,
} from '@colorful-code/schema/operations';
import {
  queueItemViewSchema,
  queueViewSchema,
  transcriptItemViewSchema,
} from '@colorful-code/schema/queue';
import { runViewSchema } from '@colorful-code/schema/run';
import { threadSnapshotSchema } from '@colorful-code/schema/snapshot';
import {
  inputItemViewSchema,
  threadViewSchema,
} from '@colorful-code/schema/thread';

const forbidden = [
  'RuntimeSession',
  'Lease',
  'workerRouting',
  'ToolExecutionAttempt',
  'LateObservationInbox',
  'projectionRevision',
  'permitId',
  'leaseEpoch',
];

describe('public resource boundary', () => {
  test('keeps internal names out of generated resource schemas', () => {
    const schemas = [
      threadViewSchema,
      runViewSchema,
      inputItemViewSchema,
      queueItemViewSchema,
      queueViewSchema,
      transcriptItemViewSchema,
      operationViewSchema,
      approvalViewSchema,
      toolExecutionSummarySchema,
      threadSnapshotSchema,
    ];
    const generated = JSON.stringify(
      schemas.map((schema) => z.toJSONSchema(schema)),
    );
    for (const name of forbidden) expect(generated).not.toContain(name);
  });
  test('keeps internal names out of public resource source', async () => {
    const sourceDir = resolve(import.meta.dir, '../src');
    for (const file of [
      'thread.ts',
      'run.ts',
      'queue.ts',
      'operations.ts',
      'snapshot.ts',
    ]) {
      const source = await Bun.file(resolve(sourceDir, file)).text();
      for (const name of forbidden) expect(source).not.toContain(name);
    }
  });
});
