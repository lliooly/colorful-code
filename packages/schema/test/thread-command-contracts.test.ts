import { describe, expect, test } from 'bun:test';

import {
  httpContractRegistry,
  threadPageSchema,
  undefinedResultSchema,
  type HttpContractRegistry,
} from '@colorful-code/schema/commands';
import { threadViewSchema } from '@colorful-code/schema/thread';

const endpoint = <OperationId extends keyof HttpContractRegistry>(
  operationId: OperationId,
): HttpContractRegistry[OperationId] => httpContractRegistry[operationId];

const typedKeys = <ObjectType extends object>(value: ObjectType) =>
  Object.keys(value) as Array<keyof ObjectType>;

const threadPath = { threadId: 'thread-1' };
const command = {
  commandId: 'command-1',
  expectedThreadRevision: 3,
};

describe('thread HTTP contract registry', () => {
  test('publishes the complete thread lifecycle and query surface', () => {
    expect(
      typedKeys(httpContractRegistry)
        .filter((operationId) => operationId.startsWith('thread.'))
        .sort(),
    ).toEqual([
      'thread.archive',
      'thread.create',
      'thread.delete',
      'thread.fork',
      'thread.get',
      'thread.list',
      'thread.patch',
      'thread.resume',
      'thread.unarchive',
      'thread.undelete',
    ]);

    expect(
      Object.fromEntries(
        Object.values(httpContractRegistry)
          .filter(({ operationId }) => operationId.startsWith('thread.'))
          .map(({ operationId, method, path }) => [
            operationId,
            `${method} ${path}`,
          ]),
      ),
    ).toEqual({
      'thread.create': 'POST /v2/threads',
      'thread.list': 'GET /v2/threads',
      'thread.get': 'GET /v2/threads/{threadId}',
      'thread.patch': 'PATCH /v2/threads/{threadId}',
      'thread.delete': 'DELETE /v2/threads/{threadId}',
      'thread.resume': 'POST /v2/threads/{threadId}/resume',
      'thread.archive': 'POST /v2/threads/{threadId}/archive',
      'thread.unarchive': 'POST /v2/threads/{threadId}/unarchive',
      'thread.undelete': 'POST /v2/threads/{threadId}/undelete',
      'thread.fork': 'POST /v2/threads/{threadId}/fork',
    });
  });

  test('freezes the registry and each endpoint descriptor', () => {
    expect(Object.isFrozen(httpContractRegistry)).toBe(true);
    for (const descriptor of Object.values(httpContractRegistry)) {
      expect(Object.isFrozen(descriptor)).toBe(true);
    }
  });

  test('publishes only the allowed keys on every endpoint descriptor', () => {
    const allowedKeysByOperation = {
      'thread.create': [
        'method',
        'path',
        'operationId',
        'bodySchema',
        'resultSchema',
        'responseKind',
      ],
      'thread.list': [
        'method',
        'path',
        'operationId',
        'querySchema',
        'resultSchema',
        'responseKind',
      ],
      'thread.get': [
        'method',
        'path',
        'operationId',
        'pathSchema',
        'querySchema',
        'resultSchema',
        'responseKind',
      ],
      'thread.patch': [
        'method',
        'path',
        'operationId',
        'pathSchema',
        'bodySchema',
        'resultSchema',
        'responseKind',
      ],
      'thread.delete': [
        'method',
        'path',
        'operationId',
        'pathSchema',
        'bodySchema',
        'resultSchema',
        'responseKind',
      ],
      'thread.resume': [
        'method',
        'path',
        'operationId',
        'pathSchema',
        'bodySchema',
        'resultSchema',
        'responseKind',
      ],
      'thread.archive': [
        'method',
        'path',
        'operationId',
        'pathSchema',
        'bodySchema',
        'resultSchema',
        'responseKind',
      ],
      'thread.unarchive': [
        'method',
        'path',
        'operationId',
        'pathSchema',
        'bodySchema',
        'resultSchema',
        'responseKind',
      ],
      'thread.undelete': [
        'method',
        'path',
        'operationId',
        'pathSchema',
        'bodySchema',
        'resultSchema',
        'responseKind',
      ],
      'thread.fork': [
        'method',
        'path',
        'operationId',
        'pathSchema',
        'bodySchema',
        'resultSchema',
        'responseKind',
      ],
    } as const;

    for (const operationId of typedKeys(allowedKeysByOperation)) {
      const allowedKeys = allowedKeysByOperation[operationId];
      expect(Object.keys(endpoint(operationId)).sort()).toEqual(
        [...allowedKeys].sort(),
      );
    }
  });

  test('uses direct resource and page schemas for queries', () => {
    expect(endpoint('thread.get').responseKind).toBe('query');
    expect(endpoint('thread.get').resultSchema).toBe(threadViewSchema);
    expect(endpoint('thread.list').responseKind).toBe('query');
    expect(endpoint('thread.list').resultSchema).toBe(threadPageSchema);
  });

  test('uses command acknowledgements with concrete mutation result schemas', () => {
    const mutationResultSchemas = {
      'thread.create': threadViewSchema,
      'thread.patch': threadViewSchema,
      'thread.delete': threadViewSchema,
      'thread.resume': undefinedResultSchema,
      'thread.archive': threadViewSchema,
      'thread.unarchive': threadViewSchema,
      'thread.undelete': undefinedResultSchema,
      'thread.fork': threadViewSchema,
    } as const;

    for (const operationId of typedKeys(mutationResultSchemas)) {
      const resultSchema = mutationResultSchemas[operationId];
      const descriptor = endpoint(operationId);
      expect(descriptor.responseKind).toBe('commandAck');
      expect(descriptor.resultSchema).toBe(resultSchema);
    }
  });

  test('requires strict thread path parameters', () => {
    for (const operationId of [
      'thread.get',
      'thread.patch',
      'thread.delete',
      'thread.resume',
      'thread.archive',
      'thread.unarchive',
      'thread.undelete',
      'thread.fork',
    ] as const) {
      const schema = endpoint(operationId).pathSchema;
      expect(schema.safeParse(threadPath).success).toBe(true);
      expect(
        schema.safeParse({ ...threadPath, clientIdentity: 'spoofed' }).success,
      ).toBe(false);
      expect(schema.safeParse({ ...threadPath, unknown: true }).success).toBe(
        false,
      );
    }
  });

  test('uses strict bounded pagination for thread list', () => {
    const schema = endpoint('thread.list').querySchema;

    for (const query of [{}, { cursor: '0' }, { limit: 1 }, { limit: 100 }]) {
      expect(schema.safeParse(query).success).toBe(true);
    }
    for (const query of [
      { limit: 0 },
      { limit: 101 },
      { limit: 1.5 },
      { commandId: 'command-1' },
      { clientIdentity: 'spoofed' },
      { payloadHash: 'spoofed' },
      { unknown: true },
    ]) {
      expect(schema.safeParse(query).success).toBe(false);
    }
    const getQuerySchema = endpoint('thread.get').querySchema;
    expect(getQuerySchema.safeParse({}).success).toBe(true);
    for (const query of [
      { clientIdentity: 'spoofed' },
      { payloadHash: 'spoofed' },
      { unknown: true },
    ]) {
      expect(getQuerySchema.safeParse(query).success).toBe(false);
    }
  });

  test('accepts only the exact create and metadata patch bodies', () => {
    const create = endpoint('thread.create').bodySchema;
    expect(create.safeParse({ commandId: 'command-1' }).success).toBe(true);
    expect(create.safeParse({}).success).toBe(false);
    expect(
      create.safeParse({
        commandId: 'command-1',
        title: 'Title',
        goal: 'Goal',
        workspaceBinding: {
          workspaceId: 'workspace-1',
          displayPath: '/workspace/project',
          trust: 'trusted',
        },
      }).success,
    ).toBe(true);
    for (const field of ['title', 'goal'] as const) {
      for (const value of ['', '   ']) {
        expect(
          create.safeParse({ commandId: 'command-1', [field]: value }).success,
        ).toBe(false);
      }
    }

    const patch = endpoint('thread.patch').bodySchema;
    expect(
      patch.safeParse({ ...command, patch: { title: 'Renamed' } }).success,
    ).toBe(true);
    expect(
      patch.safeParse({ expectedThreadRevision: 3, patch: { title: 'x' } })
        .success,
    ).toBe(false);
    expect(
      patch.safeParse({ commandId: 'command-1', patch: { title: 'x' } })
        .success,
    ).toBe(false);
    expect(
      patch.safeParse({ ...command, patch: { title: null } }).success,
    ).toBe(false);
    expect(patch.safeParse({ ...command, patch: { goal: null } }).success).toBe(
      false,
    );
    for (const field of ['title', 'goal'] as const) {
      for (const value of ['', '   ']) {
        expect(
          patch.safeParse({ ...command, patch: { [field]: value } }).success,
        ).toBe(false);
      }
    }
    expect(patch.safeParse({ ...command, patch: {} }).success).toBe(false);
    expect(
      patch.safeParse({
        ...command,
        threadId: 'thread-1',
        patch: { title: 'x' },
      }).success,
    ).toBe(false);
  });

  test('requires commandId and the thread revision fence on every lifecycle mutation', () => {
    for (const operationId of [
      'thread.delete',
      'thread.resume',
      'thread.archive',
      'thread.unarchive',
      'thread.undelete',
    ] as const) {
      const descriptor = endpoint(operationId);
      const schema = descriptor.bodySchema;
      expect(descriptor.responseKind).toBe('commandAck');
      expect(schema.safeParse(command).success).toBe(true);
      expect(schema.safeParse({ expectedThreadRevision: 3 }).success).toBe(
        false,
      );
      expect(schema.safeParse({ commandId: 'command-1' }).success).toBe(false);
    }
  });

  test('models fork boundary as a strict discriminated union', () => {
    const schema = endpoint('thread.fork').bodySchema;
    const boundary = { kind: 'latestCommitted' };

    expect(
      schema.safeParse({ expectedThreadRevision: 3, boundary }).success,
    ).toBe(false);
    expect(schema.safeParse({ commandId: 'command-1', boundary }).success).toBe(
      false,
    );

    for (const boundary of [
      { kind: 'latestCommitted' },
      { kind: 'contextBoundary', contextBoundaryId: 'context-1' },
      { kind: 'checkpoint', checkpointId: 'checkpoint-1' },
    ]) {
      expect(schema.safeParse({ ...command, boundary }).success).toBe(true);
    }
    for (const boundary of [
      undefined,
      { kind: 'latestCommitted', checkpointId: 'checkpoint-1' },
      { kind: 'contextBoundary' },
      { kind: 'checkpoint' },
      { kind: 'arbitrary', id: 'boundary-1' },
    ]) {
      expect(schema.safeParse({ ...command, boundary }).success).toBe(false);
    }
  });

  test('rejects identity, hashes, unknown fields and path identity in all bodies', () => {
    for (const descriptor of Object.values(httpContractRegistry).filter(
      ({ operationId }) => operationId.startsWith('thread.'),
    )) {
      if (!('bodySchema' in descriptor)) continue;

      const valid =
        descriptor.operationId === 'thread.create'
          ? { commandId: 'command-1' }
          : descriptor.operationId === 'thread.patch'
            ? { ...command, patch: { title: 'x' } }
            : descriptor.operationId === 'thread.fork'
              ? { ...command, boundary: { kind: 'latestCommitted' } }
              : command;

      for (const forbidden of [
        { clientIdentity: 'spoofed' },
        { payloadHash: 'spoofed' },
        { unknown: true },
        { threadId: 'thread-1' },
      ]) {
        expect(
          descriptor.bodySchema.safeParse({ ...valid, ...forbidden }).success,
        ).toBe(false);
      }
    }
  });

  test('GET descriptors never accept a command body', () => {
    for (const descriptor of Object.values(httpContractRegistry).filter(
      ({ method }) => method === 'GET',
    )) {
      expect('bodySchema' in descriptor).toBe(false);
    }
  });
});
