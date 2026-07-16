import { describe, expect, test } from 'bun:test';
import { z } from 'zod';

import { configRevisionResultSchema } from '@colorful-code/schema/config';
import {
  checkpointPageSchema,
  httpContractRegistry,
  operationPageSchema,
  undefinedResultSchema,
  type HttpContractDescriptor,
} from '@colorful-code/schema/commands';
import {
  approvalViewSchema,
  operationViewSchema,
} from '@colorful-code/schema/operations';
import { policyRevisionResultSchema } from '@colorful-code/schema/policy';
import { threadSnapshotSchema } from '@colorful-code/schema/snapshot';

const registry: Readonly<Record<string, HttpContractDescriptor>> =
  httpContractRegistry;

const endpoint = (operationId: string): HttpContractDescriptor => {
  const descriptor = registry[operationId];
  if (descriptor === undefined) {
    throw new Error(`missing endpoint: ${operationId}`);
  }
  return descriptor;
};

const schema = (value: z.ZodType | undefined): z.ZodType => {
  if (value === undefined) {
    throw new Error('expected schema');
  }
  return value;
};

const endpointMatrix = [
  ['thread.create', 'POST', '/v2/threads'],
  ['thread.list', 'GET', '/v2/threads'],
  ['thread.get', 'GET', '/v2/threads/{threadId}'],
  ['thread.patch', 'PATCH', '/v2/threads/{threadId}'],
  ['thread.delete', 'DELETE', '/v2/threads/{threadId}'],
  ['thread.resume', 'POST', '/v2/threads/{threadId}/resume'],
  ['thread.archive', 'POST', '/v2/threads/{threadId}/archive'],
  ['thread.unarchive', 'POST', '/v2/threads/{threadId}/unarchive'],
  ['thread.undelete', 'POST', '/v2/threads/{threadId}/undelete'],
  ['thread.fork', 'POST', '/v2/threads/{threadId}/fork'],
  ['submission.create', 'POST', '/v2/threads/{threadId}/submissions'],
  ['run.list', 'GET', '/v2/threads/{threadId}/runs'],
  ['run.get', 'GET', '/v2/threads/{threadId}/runs/{runId}'],
  ['run.steer', 'POST', '/v2/threads/{threadId}/runs/{runId}/steer'],
  ['run.stop', 'POST', '/v2/threads/{threadId}/runs/{runId}/stop'],
  ['queue.get', 'GET', '/v2/threads/{threadId}/queue'],
  [
    'queue.item.patch',
    'PATCH',
    '/v2/threads/{threadId}/queue/items/{queueItemId}',
  ],
  [
    'queue.item.delete',
    'DELETE',
    '/v2/threads/{threadId}/queue/items/{queueItemId}',
  ],
  ['queue.reorder', 'POST', '/v2/threads/{threadId}/queue/reorder'],
  ['queue.pause', 'POST', '/v2/threads/{threadId}/queue/pause'],
  ['queue.resume', 'POST', '/v2/threads/{threadId}/queue/resume'],
  [
    'approval.decide',
    'POST',
    '/v2/threads/{threadId}/runs/{runId}/approvals/{approvalId}/decision',
  ],
  ['config.change', 'POST', '/v2/threads/{threadId}/config/changes'],
  ['policy.change', 'POST', '/v2/threads/{threadId}/policy/changes'],
  ['operation.list', 'GET', '/v2/threads/{threadId}/operations'],
  ['operation.get', 'GET', '/v2/threads/{threadId}/operations/{operationId}'],
  ['checkpoint.list', 'GET', '/v2/threads/{threadId}/checkpoints'],
  [
    'checkpoint.apply',
    'POST',
    '/v2/threads/{threadId}/checkpoints/{checkpointId}/apply',
  ],
  ['snapshot.get', 'GET', '/v2/threads/{threadId}/snapshot'],
  ['event.attach', 'GET', '/v2/threads/{threadId}/events'],
] as const;

describe('remaining v2 HTTP contract registry', () => {
  test('matches the exact normative 30-endpoint matrix', () => {
    expect(
      Object.entries(registry)
        .map(
          ([key, descriptor]) =>
            [
              key,
              descriptor.operationId,
              descriptor.method,
              descriptor.path,
            ] as const,
        )
        .sort(([leftOperationId], [rightOperationId]) =>
          leftOperationId.localeCompare(rightOperationId),
        ),
    ).toEqual(
      endpointMatrix
        .map(([operationId, method, path]) => [
          operationId,
          operationId,
          method,
          path,
        ])
        .sort(([leftOperationId], [rightOperationId]) =>
          leftOperationId.localeCompare(rightOperationId),
        ),
    );
  });

  test('constructs and freezes the registry as immutable metadata', () => {
    expect(Object.isFrozen(registry)).toBe(true);
    for (const [key, descriptor] of Object.entries(registry)) {
      expect(descriptor.operationId).toBe(key);
      expect(Object.isFrozen(descriptor)).toBe(true);
      expect(Object.keys(descriptor)).not.toContain('handler');
      expect(Object.keys(descriptor)).not.toContain('controller');
      expect(Object.keys(descriptor)).not.toContain('register');
    }
  });

  test('binds every remaining endpoint to its exact response contract', () => {
    const expectedResponses = {
      'approval.decide': ['commandAck', approvalViewSchema],
      'config.change': ['commandAck', configRevisionResultSchema],
      'policy.change': ['commandAck', policyRevisionResultSchema],
      'operation.list': ['query', operationPageSchema],
      'operation.get': ['query', operationViewSchema],
      'checkpoint.list': ['query', checkpointPageSchema],
      'checkpoint.apply': ['commandAck', undefinedResultSchema],
      'snapshot.get': ['query', threadSnapshotSchema],
      'event.attach': ['query', undefinedResultSchema],
    } as const;

    for (const [operationId, [responseKind, resultSchema]] of Object.entries(
      expectedResponses,
    )) {
      const descriptor = endpoint(operationId);
      expect(descriptor.responseKind).toBe(responseKind);
      expect(descriptor.resultSchema).toBe(resultSchema);
    }
  });
});

describe('approval decision contract', () => {
  const path = {
    threadId: 'thread-1',
    runId: 'run-1',
    approvalId: 'approval-1',
  };
  const body = {
    commandId: 'command-1',
    expectedPlanGeneration: 2,
    expectedApprovalRevision: 3,
    decision: 'approve',
    reason: 'reviewed',
  };

  test('requires exact path identity and optimistic-concurrency fences', () => {
    const descriptor = endpoint('approval.decide');
    expect(schema(descriptor.pathSchema).safeParse(path).success).toBe(true);
    expect(schema(descriptor.bodySchema).safeParse(body).success).toBe(true);

    for (const field of [
      'commandId',
      'expectedPlanGeneration',
      'expectedApprovalRevision',
    ] as const) {
      const { [field]: _removed, ...withoutFence } = body;
      expect(
        schema(descriptor.bodySchema).safeParse(withoutFence).success,
      ).toBe(false);
    }
  });

  test('rejects server-owned, runtime and duplicated path identity fields', () => {
    const descriptor = endpoint('approval.decide');
    for (const field of [
      'classification',
      'policyClassification',
      'leaseEpoch',
      'incarnationId',
      'threadId',
      'runId',
      'approvalId',
      'clientIdentity',
      'payloadHash',
    ]) {
      expect(
        schema(descriptor.bodySchema).safeParse({ ...body, [field]: 'owned' })
          .success,
      ).toBe(false);
    }
    expect(
      schema(descriptor.pathSchema).safeParse({ ...path, extra: true }).success,
    ).toBe(false);
  });
});

describe('config and policy change contracts', () => {
  test('accepts bounded config fields and rejects empty, unsafe or foreign patches', () => {
    const descriptor = endpoint('config.change');
    const bodySchema = schema(descriptor.bodySchema);
    const patch = {
      model: 'gpt-example',
      provider: 'example',
      providerCredentialRef: 'credential-1',
      temperature: 1.25,
      topP: 0.9,
      maxOutputTokens: 4096,
      reasoningEffort: 'high',
      providerOptions: { seed: 7, stop: ['END'], nested: { enabled: true } },
    };
    expect(
      bodySchema.safeParse({
        commandId: 'command-1',
        expectedConfigRevision: 1,
        patch,
      }).success,
    ).toBe(true);
    for (const invalid of [
      {},
      { ...patch, temperature: Number.NaN },
      { ...patch, temperature: 2.1 },
      { ...patch, topP: -0.1 },
      { ...patch, topP: 1.1 },
      { ...patch, maxOutputTokens: 0 },
      { ...patch, maxOutputTokens: Number.MAX_SAFE_INTEGER + 1 },
      { ...patch, reasoningEffort: 'unbounded' },
      { ...patch, providerOptions: { callback: () => undefined } },
      { ...patch, workspaceTrust: 'trusted' },
      { ...patch, unknown: true },
      { ...patch, secret: 'plaintext' },
      { ...patch, apiKey: 'plaintext' },
      {
        ...patch,
        providerCredential: { provider: 'example', value: 'plaintext' },
      },
    ]) {
      expect(
        bodySchema.safeParse({
          commandId: 'command-1',
          expectedConfigRevision: 1,
          patch: invalid,
        }).success,
      ).toBe(false);
    }

    const body = { commandId: 'command-1', expectedConfigRevision: 1, patch };
    expect(bodySchema.safeParse(body).success).toBe(true);
    for (const field of ['commandId', 'expectedConfigRevision'] as const) {
      const { [field]: _removed, ...withoutFence } = body;
      expect(bodySchema.safeParse(withoutFence).success).toBe(false);
    }
    expect(descriptor.resultSchema.parse({ configRevision: 2 })).toEqual({
      configRevision: 2,
    });
    expect(
      descriptor.resultSchema.safeParse({ configRevision: 2, ack: true })
        .success,
    ).toBe(false);
  });

  test('accepts bounded policy fields and rejects classification or unknown shapes', () => {
    const descriptor = endpoint('policy.change');
    const bodySchema = schema(descriptor.bodySchema);
    const patch = {
      workspaceTrust: 'untrusted',
      sandbox: 'workspaceWrite',
      network: { mode: 'allowListed', allowedHosts: ['api.example.com'] },
      pluginCapabilities: [
        { pluginId: 'plugin-1', capabilities: ['read', 'write'] },
      ],
      credentialRefs: ['credential-1'],
      revokeCredentialRefs: ['credential-2'],
    };
    expect(
      bodySchema.safeParse({
        commandId: 'command-1',
        expectedPolicyRevision: 1,
        patch,
      }).success,
    ).toBe(true);
    for (const invalid of [
      {},
      { ...patch, sandbox: 'hostRoot' },
      { ...patch, network: { mode: 'anything' } },
      { ...patch, network: { mode: 'denyAll', allowedHosts: ['example.com'] } },
      {
        ...patch,
        pluginCapabilities: [
          { pluginId: 'plugin-1', capabilities: ['read'], extra: true },
        ],
      },
      { ...patch, classification: 'relaxation' },
      { ...patch, effectivePolicy: {} },
      { ...patch, unknown: true },
      { ...patch, secret: 'plaintext' },
      { ...patch, apiKey: 'plaintext' },
      {
        ...patch,
        credential: { credentialRef: 'credential-3', value: 'plaintext' },
      },
    ]) {
      expect(
        bodySchema.safeParse({
          commandId: 'command-1',
          expectedPolicyRevision: 1,
          patch: invalid,
        }).success,
      ).toBe(false);
    }

    const body = { commandId: 'command-1', expectedPolicyRevision: 1, patch };
    expect(bodySchema.safeParse(body).success).toBe(true);
    for (const field of ['commandId', 'expectedPolicyRevision'] as const) {
      const { [field]: _removed, ...withoutFence } = body;
      expect(bodySchema.safeParse(withoutFence).success).toBe(false);
    }
    expect(descriptor.resultSchema.parse({ policyRevision: 2 })).toEqual({
      policyRevision: 2,
    });
    expect(
      descriptor.resultSchema.safeParse({ policyRevision: 2, ack: true })
        .success,
    ).toBe(false);
  });
});

describe('operation, checkpoint, snapshot and event query contracts', () => {
  test('validates operation filters and strict resource paths', () => {
    const list = endpoint('operation.list');
    expect(
      schema(list.querySchema).safeParse({
        status: 'waiting',
        kind: 'steer',
        cursor: '42',
        limit: 100,
      }).success,
    ).toBe(true);
    for (const query of [
      { limit: 0 },
      { limit: 101 },
      { status: 'unknown' },
      { kind: ['steer'] },
      { extra: true },
    ]) {
      expect(schema(list.querySchema).safeParse(query).success).toBe(false);
    }

    const get = endpoint('operation.get');
    expect(
      schema(get.pathSchema).safeParse({
        threadId: 'thread-1',
        operationId: 'operation-1',
      }).success,
    ).toBe(true);
    expect(
      schema(get.pathSchema).safeParse({
        threadId: 'thread-1',
        operationId: 'operation-1',
        runId: 'run-1',
      }).success,
    ).toBe(false);
  });

  test('uses a minimal strict checkpoint summary and fences apply', () => {
    const list = endpoint('checkpoint.list');
    expect(
      list.resultSchema.safeParse({
        items: [
          {
            checkpointId: 'checkpoint-1',
            threadId: 'thread-1',
            createdAt: '2026-07-16T10:00:00+08:00',
            revision: 2,
          },
        ],
        pageInfo: { nextCursor: null, hasMore: false },
      }).success,
    ).toBe(true);
    expect(
      list.resultSchema.safeParse({
        items: [
          {
            checkpointId: 'checkpoint-1',
            threadId: 'thread-1',
            createdAt: '2026-07-16T10:00:00+08:00',
            revision: 2,
            payload: {},
          },
        ],
        pageInfo: { nextCursor: null, hasMore: false },
      }).success,
    ).toBe(false);

    const apply = endpoint('checkpoint.apply');
    const body = {
      commandId: 'command-1',
      expectedThreadRevision: 2,
      expectedCheckpointRevision: 3,
    };
    expect(schema(apply.bodySchema).safeParse(body).success).toBe(true);
    for (const field of Object.keys(body) as (keyof typeof body)[]) {
      const { [field]: _removed, ...withoutFence } = body;
      expect(schema(apply.bodySchema).safeParse(withoutFence).success).toBe(
        false,
      );
    }
  });

  test('uses an empty strict snapshot query and paired event stream cursors', () => {
    const snapshot = endpoint('snapshot.get');
    expect(schema(snapshot.querySchema).safeParse({}).success).toBe(true);
    expect(
      schema(snapshot.querySchema).safeParse({ threadId: 'thread-1' }).success,
    ).toBe(false);

    const events = endpoint('event.attach');
    const query = schema(events.querySchema);
    for (const valid of [
      {},
      { durableAfter: '9007199254740993' },
      { incarnationId: 'incarnation-1', streamAfter: '7' },
      {
        durableAfter: '8',
        incarnationId: 'incarnation-1',
        streamAfter: '9',
      },
    ]) {
      expect(query.safeParse(valid).success).toBe(true);
    }
    for (const invalid of [
      { incarnationId: 'incarnation-1' },
      { streamAfter: '1' },
      { durableAfter: 1 },
      { durableAfter: '01' },
      { streamAfter: -1, incarnationId: 'incarnation-1' },
      { durableAfter: '1', extra: true },
    ]) {
      expect(query.safeParse(invalid).success).toBe(false);
    }
    expect(events.responseKind).toBe('query');
    expect(events.resultSchema.safeParse(undefined).success).toBe(true);
  });
});
