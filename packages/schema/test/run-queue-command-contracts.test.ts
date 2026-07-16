import { describe, expect, test } from 'bun:test';
import type { ZodType } from 'zod';

import {
  httpContractRegistry,
  runPageSchema,
  type HttpContractRegistry,
} from '@colorful-code/schema/commands';
import { queueViewSchema } from '@colorful-code/schema/queue';
import { runViewSchema } from '@colorful-code/schema/run';

const endpoint = <OperationId extends keyof HttpContractRegistry>(
  operationId: OperationId,
): HttpContractRegistry[OperationId] => httpContractRegistry[operationId];

const schema = (value: ZodType | undefined): ZodType => {
  expect(value).toBeDefined();
  if (value === undefined) throw new Error('expected endpoint schema');
  return value;
};

const typedEntries = <ObjectType extends object>(value: ObjectType) =>
  Object.entries(value) as Array<
    {
      [Key in keyof ObjectType]: [Key, ObjectType[Key]];
    }[keyof ObjectType]
  >;

const textInput = { content: { kind: 'text', text: 'hello' } };
const commandId = 'command-1';
const threadPath = { threadId: 'thread-1' };
const runPath = { ...threadPath, runId: 'run-1' };
const queueItemPath = { ...threadPath, queueItemId: 'queue-item-1' };
const operationAck = {
  commandId,
  operationId: 'operation-1',
  status: 'accepted',
  replayed: false,
  threadId: 'thread-1',
  currentDurableCursor: '1',
  acceptedAt: '2026-07-16T00:00:00Z',
};
const ackWithResult = (result: unknown) => ({ ...operationAck, result });

describe('submission and run HTTP contracts', () => {
  test('publishes the exact submission and run endpoints', () => {
    expect(
      Object.fromEntries(
        (
          [
            'submission.create',
            'run.list',
            'run.get',
            'run.steer',
            'run.stop',
          ] as const
        ).map((operationId) => {
          const { method, path } = endpoint(operationId);
          return [operationId, `${method} ${path}`];
        }),
      ),
    ).toEqual({
      'submission.create': 'POST /v2/threads/{threadId}/submissions',
      'run.list': 'GET /v2/threads/{threadId}/runs',
      'run.get': 'GET /v2/threads/{threadId}/runs/{runId}',
      'run.steer': 'POST /v2/threads/{threadId}/runs/{runId}/steer',
      'run.stop': 'POST /v2/threads/{threadId}/runs/{runId}/stop',
    });
  });

  test('accepts only bounded client input for submissions', () => {
    const body = schema(endpoint('submission.create').bodySchema);
    const valid = {
      commandId,
      input: textInput,
      disposition: 'auto',
    };

    expect(body.safeParse(valid).success).toBe(true);
    for (const missing of ['commandId', 'input', 'disposition'] as const) {
      const candidate: Record<string, unknown> = { ...valid };
      delete candidate[missing];
      expect(body.safeParse(candidate).success).toBe(false);
    }
    for (const serverOwned of [
      { inputItemId: 'input-1' },
      { threadId: 'thread-1' },
      { role: 'user' },
      { source: 'submission' },
      { createdAt: '2026-07-16T00:00:00Z' },
    ]) {
      expect(
        body.safeParse({ ...valid, input: { ...textInput, ...serverOwned } })
          .success,
      ).toBe(false);
    }
    expect(
      body.safeParse({ ...valid, input: { content: { kind: 'text' } } })
        .success,
    ).toBe(false);
    expect(body.safeParse({ ...valid, disposition: 'later' }).success).toBe(
      false,
    );
  });

  test('models submission result as the exact discriminated union', () => {
    const descriptor = endpoint('submission.create');
    expect(descriptor.responseKind).toBe('commandAck');
    const result = descriptor.resultSchema;

    for (const value of [
      { kind: 'runCreated', inputItemId: 'input-1', runId: 'run-1' },
      {
        kind: 'queueItemCreated',
        inputItemId: 'input-1',
        queueItemId: 'queue-item-1',
      },
    ]) {
      expect(result.safeParse(ackWithResult(value)).success).toBe(true);
    }
    for (const value of [
      { kind: 'runCreated', inputItemId: 'input-1' },
      {
        kind: 'runCreated',
        inputItemId: 'input-1',
        runId: 'run-1',
        queueItemId: 'queue-item-1',
      },
      {
        kind: 'queueItemCreated',
        inputItemId: 'input-1',
        runId: 'run-1',
      },
      { kind: 'unknown', inputItemId: 'input-1' },
    ]) {
      expect(result.safeParse(ackWithResult(value)).success).toBe(false);
    }
  });

  test('uses strict run paths, bounded pagination and direct run results', () => {
    const list = endpoint('run.list');
    const get = endpoint('run.get');

    expect(list.responseKind).toBe('query');
    expect(get.responseKind).toBe('query');
    expect(list.resultSchema).toBe(runPageSchema);
    expect(get.resultSchema).toBe(runViewSchema);
    for (const query of [{}, { cursor: '0' }, { limit: 1 }, { limit: 100 }]) {
      expect(schema(list.querySchema).safeParse(query).success).toBe(true);
    }
    for (const query of [
      { limit: 0 },
      { limit: 101 },
      { clientIdentity: 'spoofed' },
      { payloadHash: 'spoofed' },
      { unknown: true },
    ]) {
      expect(schema(list.querySchema).safeParse(query).success).toBe(false);
    }
    expect(schema(get.querySchema).safeParse({}).success).toBe(true);
    for (const forbidden of [
      { clientIdentity: 'spoofed' },
      { payloadHash: 'spoofed' },
      { unknown: true },
    ]) {
      expect(schema(get.querySchema).safeParse(forbidden).success).toBe(false);
    }

    for (const [operationId, validPath] of [
      ['submission.create', threadPath],
      ['run.list', threadPath],
      ['run.get', runPath],
      ['run.steer', runPath],
      ['run.stop', runPath],
    ] as const) {
      const pathSchema = schema(endpoint(operationId).pathSchema);
      expect(pathSchema.safeParse(validPath).success).toBe(true);
      for (const forbidden of [
        { clientIdentity: 'spoofed' },
        { payloadHash: 'spoofed' },
        { unknown: true },
      ]) {
        expect(
          pathSchema.safeParse({ ...validPath, ...forbidden }).success,
        ).toBe(false);
      }
    }
  });

  test('requires all steer fences and applies enqueue by default', () => {
    const descriptor = endpoint('run.steer');
    const body = schema(descriptor.bodySchema);
    const valid = {
      commandId,
      expectedPlanGeneration: 3,
      targetConfigRevision: 4,
      expectedPolicyRevision: 5,
      input: textInput,
    };

    expect(body.parse(valid)).toEqual({ ...valid, stalePolicy: 'enqueue' });
    expect(body.parse({ ...valid, stalePolicy: 'reject' }).stalePolicy).toBe(
      'reject',
    );
    for (const missing of [
      'commandId',
      'expectedPlanGeneration',
      'targetConfigRevision',
      'expectedPolicyRevision',
      'input',
    ] as const) {
      const candidate: Record<string, unknown> = { ...valid };
      delete candidate[missing];
      expect(body.safeParse(candidate).success).toBe(false);
    }
    expect(descriptor.responseKind).toBe('commandAck');
    expect(descriptor.resultSchema.parse(operationAck)).toEqual(operationAck);
    expect(descriptor.resultSchema.safeParse(ackWithResult(null)).success).toBe(
      false,
    );
  });

  test('defaults stop to atomically pausing the queue', () => {
    const descriptor = endpoint('run.stop');
    const body = schema(descriptor.bodySchema);

    expect(body.parse({ commandId })).toEqual({ commandId, pauseQueue: true });
    expect(body.safeParse({}).success).toBe(false);
    expect(body.parse({ commandId, pauseQueue: false })).toEqual({
      commandId,
      pauseQueue: false,
    });
    expect(descriptor.responseKind).toBe('commandAck');
    expect(descriptor.resultSchema.parse(operationAck)).toEqual(operationAck);
    expect(
      descriptor.resultSchema.safeParse(ackWithResult({ stopped: true }))
        .success,
    ).toBe(false);
  });

  test('rejects spoofed metadata and path identity in run command bodies', () => {
    const commands = {
      'submission.create': {
        commandId,
        input: textInput,
        disposition: 'auto',
      },
      'run.steer': {
        commandId,
        expectedPlanGeneration: 3,
        targetConfigRevision: 4,
        expectedPolicyRevision: 5,
        input: textInput,
      },
      'run.stop': { commandId },
    } as const;

    for (const [operationId, body] of typedEntries(commands)) {
      const bodySchema = schema(endpoint(operationId).bodySchema);
      for (const forbidden of [
        { clientIdentity: 'spoofed' },
        { payloadHash: 'spoofed' },
        { unknown: true },
        { threadId: 'thread-1' },
        { runId: 'run-1' },
      ]) {
        expect(bodySchema.safeParse({ ...body, ...forbidden }).success).toBe(
          false,
        );
      }
    }
  });
});

describe('queue HTTP contracts', () => {
  const queueMutations = {
    'queue.item.patch': {
      ...queueItemPath,
      body: {
        commandId,
        expectedQueueRevision: 7,
        expectedItemRevision: 2,
        input: textInput,
      },
    },
    'queue.item.delete': {
      ...queueItemPath,
      body: { commandId, expectedQueueRevision: 7 },
    },
    'queue.reorder': {
      ...threadPath,
      body: {
        commandId,
        expectedQueueRevision: 7,
        queueItemId: 'queue-item-1',
        beforeItemId: 'queue-item-2',
      },
    },
    'queue.pause': {
      ...threadPath,
      body: { commandId, expectedQueueRevision: 7 },
    },
    'queue.resume': {
      ...threadPath,
      body: { commandId, expectedQueueRevision: 7 },
    },
  } as const;

  test('publishes the exact queue endpoint surface', () => {
    expect(
      Object.fromEntries(
        (
          [
            'queue.get',
            'queue.item.patch',
            'queue.item.delete',
            'queue.reorder',
            'queue.pause',
            'queue.resume',
          ] as const
        ).map((operationId) => {
          const { method, path } = endpoint(operationId);
          return [operationId, `${method} ${path}`];
        }),
      ),
    ).toEqual({
      'queue.get': 'GET /v2/threads/{threadId}/queue',
      'queue.item.patch':
        'PATCH /v2/threads/{threadId}/queue/items/{queueItemId}',
      'queue.item.delete':
        'DELETE /v2/threads/{threadId}/queue/items/{queueItemId}',
      'queue.reorder': 'POST /v2/threads/{threadId}/queue/reorder',
      'queue.pause': 'POST /v2/threads/{threadId}/queue/pause',
      'queue.resume': 'POST /v2/threads/{threadId}/queue/resume',
    });
    expect(endpoint('queue.get').resultSchema).toBe(queueViewSchema);
    expect(endpoint('queue.get').responseKind).toBe('query');
    const querySchema = schema(endpoint('queue.get').querySchema);
    expect(querySchema.safeParse({}).success).toBe(true);
    for (const forbidden of [
      { clientIdentity: 'spoofed' },
      { payloadHash: 'spoofed' },
      { unknown: true },
    ]) {
      expect(querySchema.safeParse(forbidden).success).toBe(false);
    }
  });

  test('uses strict queue paths', () => {
    for (const [operationId, value] of [
      ['queue.get', threadPath],
      ['queue.item.patch', queueItemPath],
      ['queue.item.delete', queueItemPath],
      ['queue.reorder', threadPath],
      ['queue.pause', threadPath],
      ['queue.resume', threadPath],
    ] as const) {
      const pathSchema = schema(endpoint(operationId).pathSchema);
      expect(pathSchema.safeParse(value).success).toBe(true);
      for (const forbidden of [
        { clientIdentity: 'spoofed' },
        { payloadHash: 'spoofed' },
        { unknown: true },
      ]) {
        expect(pathSchema.safeParse({ ...value, ...forbidden }).success).toBe(
          false,
        );
      }
    }
  });

  test('requires the queue revision fence on every actual mutation', () => {
    for (const [operationId, { body }] of typedEntries(queueMutations)) {
      const descriptor = endpoint(operationId);
      const bodySchema = schema(descriptor.bodySchema);
      expect(bodySchema.safeParse(body).success).toBe(true);
      const withoutFence: Record<string, unknown> = { ...body };
      delete withoutFence.expectedQueueRevision;
      expect(bodySchema.safeParse(withoutFence).success).toBe(false);
      const withoutCommandId: Record<string, unknown> = { ...body };
      delete withoutCommandId.commandId;
      expect(bodySchema.safeParse(withoutCommandId).success).toBe(false);
      expect(descriptor.responseKind).toBe('commandAck');
    }
  });

  test('requires an item fence and bounded replacement input for patch', () => {
    const body = queueMutations['queue.item.patch'].body;
    const bodySchema = schema(endpoint('queue.item.patch').bodySchema);
    const withoutItemFence: Record<string, unknown> = { ...body };
    delete withoutItemFence.expectedItemRevision;

    expect(bodySchema.safeParse(withoutItemFence).success).toBe(false);
    expect(
      bodySchema.safeParse({
        ...body,
        input: { ...textInput, role: 'user' },
      }).success,
    ).toBe(false);
  });

  test('requires exactly one relative reorder anchor and rejects indexes', () => {
    const bodySchema = schema(endpoint('queue.reorder').bodySchema);
    const base = {
      commandId,
      expectedQueueRevision: 7,
      queueItemId: 'queue-item-1',
    };

    expect(
      bodySchema.safeParse({ ...base, beforeItemId: 'queue-item-2' }).success,
    ).toBe(true);
    expect(
      bodySchema.safeParse({ ...base, afterItemId: 'queue-item-2' }).success,
    ).toBe(true);
    for (const invalid of [
      base,
      {
        ...base,
        beforeItemId: 'queue-item-2',
        afterItemId: 'queue-item-3',
      },
      { ...base, beforeItemId: 'queue-item-2', index: 0 },
      { ...base, beforeItemId: 'queue-item-2', position: 1 },
    ]) {
      expect(bodySchema.safeParse(invalid).success).toBe(false);
    }
  });

  test('uses strict bounded queue mutation results', () => {
    const patchResult = endpoint('queue.item.patch').resultSchema;
    const revisionResultOperations = [
      'queue.item.delete',
      'queue.reorder',
      'queue.pause',
      'queue.resume',
    ] as const;
    const item = {
      queueItemId: 'queue-item-1',
      threadId: 'thread-1',
      input: {
        inputItemId: 'input-1',
        threadId: 'thread-1',
        role: 'user',
        source: 'submission',
        content: { kind: 'text', text: 'hello' },
        supersedesInputItemId: null,
        createdAt: '2026-07-16T00:00:00Z',
      },
      status: 'queued',
      sourceRunId: null,
      resultingRunId: null,
      revision: 2,
      createdAt: '2026-07-16T00:00:00Z',
      updatedAt: '2026-07-16T00:00:00Z',
    };

    expect(
      patchResult.safeParse(ackWithResult({ queueRevision: 8, item })).success,
    ).toBe(true);
    expect(
      patchResult.safeParse(
        ackWithResult({ queueRevision: 8, item, unknown: true }),
      ).success,
    ).toBe(false);
    for (const operationId of revisionResultOperations) {
      const result = endpoint(operationId).resultSchema;
      expect(
        result.safeParse(ackWithResult({ queueRevision: 8 })).success,
      ).toBe(true);
      expect(
        result.safeParse(ackWithResult({ queueRevision: 8, unknown: true }))
          .success,
      ).toBe(false);
    }
  });

  test('rejects spoofed metadata and path identity in all mutation bodies', () => {
    for (const [operationId, { body }] of typedEntries(queueMutations)) {
      const bodySchema = schema(endpoint(operationId).bodySchema);
      for (const forbidden of [
        { clientIdentity: 'spoofed' },
        { payloadHash: 'spoofed' },
        { unknown: true },
        { threadId: 'thread-1' },
        { runId: 'run-1' },
        { queueItemIdInPath: 'queue-item-1' },
      ]) {
        expect(bodySchema.safeParse({ ...body, ...forbidden }).success).toBe(
          false,
        );
      }
    }

    for (const operationId of [
      'queue.item.patch',
      'queue.item.delete',
    ] as const) {
      const body = queueMutations[operationId].body;
      expect(
        schema(endpoint(operationId).bodySchema).safeParse({
          ...body,
          queueItemId: 'queue-item-1',
        }).success,
      ).toBe(false);
    }
  });
});
