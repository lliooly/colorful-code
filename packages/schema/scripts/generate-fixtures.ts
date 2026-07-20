import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';

import { parseThreadStreamFrame } from '../src/events.js';
import { publishGeneratedOutputs } from './generate.js';
export {
  fixtureManifestEntrySchema,
  fixtureManifestSchema,
  resolveFixtureSchema,
  validateManifestPaths,
} from './lib/fixture-manifest.js';
import {
  fixtureManifestSchema,
  resolveFixtureSchema,
  validateManifestPaths,
  type FixtureManifestEntry,
} from './lib/fixture-manifest.js';
import { stableJson } from './lib/stable-json.js';

type AuthoredCase = FixtureManifestEntry & { readonly value: unknown };

const at = '2026-07-17T10:00:00+08:00';
const thread = {
  threadId: 'thread-1',
  lineageId: 'lineage-1',
  parentThreadId: null,
  lifecycle: 'available',
  runtimeStatus: 'idle',
  title: null,
  goal: null,
  workspaceBinding: {
    workspaceId: 'workspace-1',
    displayPath: '/workspace',
    trust: 'trusted',
  },
  activeRunId: null,
  threadRevision: 1,
  queueRevision: 1,
  configRevision: 1,
  policyRevision: 1,
  createdAt: at,
  updatedAt: at,
} as const;
const snapshot = {
  thread,
  recentRuns: { items: [], pageInfo: { nextCursor: null, hasMore: false } },
  queue: {
    threadId: 'thread-1',
    items: [],
    controlState: 'active',
    blockedByIndeterminate: false,
    effectiveState: 'active',
    revision: 1,
  },
  pendingOperations: [],
  pendingApprovals: [],
  transcript: { items: [], pageInfo: { nextCursor: null, hasMore: false } },
  toolExecutions: [],
  durableCursor: '41',
  snapshotVersion: 1,
} as const;
const run = {
  runId: 'run-1',
  threadId: 'thread-1',
  kind: 'interactive',
  status: 'running',
  sourceInputItemId: 'input-1',
  sourceQueueItemId: null,
  planGeneration: 1,
  configRevision: 1,
  policyRevision: 1,
  terminalReason: null,
  startedAt: at,
  endedAt: null,
  createdAt: at,
  updatedAt: at,
  revision: 1,
} as const;
const inputItem = {
  inputItemId: 'input-1',
  threadId: 'thread-1',
  role: 'user',
  source: 'submission',
  content: { kind: 'text', text: 'Fixture input' },
  supersedesInputItemId: null,
  createdAt: at,
} as const;
const approval = {
  approvalId: 'approval-1',
  threadId: 'thread-1',
  runId: 'run-1',
  kind: 'toolExecution',
  status: 'pending',
  planGeneration: 1,
  policyRevision: 1,
  requestSummary: { fixture: true },
  decision: null,
  revision: 1,
  createdAt: at,
  updatedAt: at,
  decidedAt: null,
  expiresAt: null,
} as const;
const toolExecution = {
  toolExecutionId: 'tool-execution-1',
  threadId: 'thread-1',
  runId: 'run-1',
  toolName: 'fixture-tool',
  state: 'completed',
  planGeneration: 1,
  policyRevision: 1,
  redactedSummary: { result: 'fixture' },
  artifacts: [],
  createdAt: at,
  updatedAt: at,
  completedAt: at,
} as const;
const unknownDurable = {
  eventId: 'event-unknown-durable',
  threadId: 'thread-1',
  kind: 'plugin.futureDurable',
  critical: false,
  occurredAt: at,
  payload: { future: true },
  durability: 'durable',
  durableSequence: '9007199254740993',
} as const;
const unknownTransient = {
  eventId: 'event-unknown-transient',
  threadId: 'thread-1',
  kind: 'plugin.futureTransient',
  critical: false,
  occurredAt: at,
  payload: ['future'],
  durability: 'transient',
  incarnationId: 'incarnation-1',
  streamSequence: '9007199254740994',
  durableBasis: '9007199254740993',
} as const;

const enumSchemaNames = [
  'ApprovalDecision',
  'ApprovalKind',
  'ApprovalStatus',
  'AuthenticatedPrincipalKind',
  'EffectiveQueueDispatchState',
  'ErrorCode',
  'InputRole',
  'InputSource',
  'OperationCompletionEventKind',
  'OperationKind',
  'OperationStatus',
  'QueueControlState',
  'QueueItemStatus',
  'ReasoningEffort',
  'RunKind',
  'RunStatus',
  'SandboxPolicy',
  'SnapshotResetReason',
  'SteerStalePolicy',
  'StreamInterruptionReason',
  'StreamStateStatus',
  'SubmissionDisposition',
  'ThreadLifecycle',
  'ThreadRuntimeStatus',
  'ToolExecutionState',
  'TranscriptItemKind',
  'TranscriptStatus',
  'WorkspaceTrust',
] as const;

const createAuthoredCases = (): AuthoredCase[] => {
  const cases: AuthoredCase[] = [];
  const add = (
    id: string,
    schema: string,
    value: unknown,
    expect: 'accept' | 'reject' = 'accept',
    expectedOutcome?: FixtureManifestEntry['expectedOutcome'],
  ) => {
    let success: boolean;
    try {
      success = resolveFixtureSchema(schema).safeParse(value).success;
    } catch (error) {
      throw new TypeError(`fixture schema evaluation failed for ${id}`, {
        cause: error,
      });
    }
    if (success !== (expect === 'accept')) {
      throw new TypeError(`fixture authoring validation failed for ${id}`);
    }
    if (expectedOutcome !== undefined) {
      const outcome = parseThreadStreamFrame(value).outcome;
      if (outcome !== expectedOutcome) {
        throw new TypeError(
          `fixture parser outcome validation failed for ${id}`,
        );
      }
    }
    cases.push({
      id,
      schema,
      file: `${expect === 'accept' ? 'valid' : 'invalid'}/${id}.json`,
      expect,
      ...(expectedOutcome === undefined ? {} : { expectedOutcome }),
      value,
    });
  };

  for (const name of enumSchemaNames) {
    const schema = resolveFixtureSchema(`schema:${name}`) as z.ZodEnum;
    for (const value of schema.options) {
      add(`enum.${name}.${value}`, `schema:${name}`, value);
    }
  }

  add('optional.absent', 'schema:PaginationQuery', {});
  add('nullable.null', 'schema:JsonValue', null);
  add('optional-nullable.absent', 'schema:ConfigPatch', { model: 'fixture' });
  add('optional-nullable.null', 'schema:ConfigPatch', {
    providerCredentialRef: null,
  });
  add('optional-nullable.value', 'schema:ConfigPatch', {
    providerCredentialRef: 'credential-ref-1',
  });
  add('cursor.above-safe-integer', 'schema:DurableCursor', '9007199254740993');

  for (const [kind, value] of [
    ['latestCommitted', { kind: 'latestCommitted' }],
    [
      'contextBoundary',
      { kind: 'contextBoundary', contextBoundaryId: 'boundary-1' },
    ],
    ['checkpoint', { kind: 'checkpoint', checkpointId: 'checkpoint-1' }],
  ] as const)
    add(`union.ForkBoundary.${kind}`, 'schema:ForkBoundary', value);
  for (const [kind, value] of [
    ['text', { kind: 'text', text: 'hello' }],
    ['structured', { kind: 'structured', value: { fixture: true } }],
    [
      'artifactReferences',
      { kind: 'artifactReferences', artifactIds: ['artifact-1'] },
    ],
  ] as const)
    add(`union.InputContent.${kind}`, 'schema:InputContent', value);
  add('union.NetworkPolicy.denyAll', 'schema:NetworkPolicy', {
    mode: 'denyAll',
  });
  add('union.NetworkPolicy.allowListed', 'schema:NetworkPolicy', {
    mode: 'allowListed',
    allowedHosts: ['example.com'],
  });
  add('union.SubmissionResult.runCreated', 'schema:SubmissionResult', {
    kind: 'runCreated',
    inputItemId: 'input-1',
    runId: 'run-1',
  });
  add('union.SubmissionResult.queueItemCreated', 'schema:SubmissionResult', {
    kind: 'queueItemCreated',
    inputItemId: 'input-1',
    queueItemId: 'queue-item-1',
  });
  const operationTerminalBase = {
    operationId: 'operation-1',
    kind: 'steer',
    runId: 'run-1',
    revision: 1,
  } as const;
  add(
    'union.OperationTerminalEventPayload.completed',
    'schema:OperationTerminalEventPayload',
    { ...operationTerminalBase, status: 'completed', completedAt: at },
  );
  add(
    'union.OperationTerminalEventPayload.failed',
    'schema:OperationTerminalEventPayload',
    {
      ...operationTerminalBase,
      status: 'failed',
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Fixture operation failed',
        retryable: false,
      },
    },
  );
  add(
    'union.OperationTerminalEventPayload.cancelled',
    'schema:OperationTerminalEventPayload',
    {
      ...operationTerminalBase,
      status: 'cancelled',
      reason: 'Fixture cancellation',
      cancelledAt: at,
    },
  );
  add(
    'union.AssistantTranscriptPayload.streaming',
    'schema:AssistantTranscriptPayload',
    { status: 'streaming', content: 'partial', finishReason: null },
  );
  add(
    'union.AssistantTranscriptPayload.interrupted',
    'schema:AssistantTranscriptPayload',
    { status: 'interrupted', content: 'partial', finishReason: 'stopped' },
  );
  add(
    'union.AssistantTranscriptPayload.completed',
    'schema:AssistantTranscriptPayload',
    { status: 'completed', content: 'complete', finishReason: 'stop' },
  );
  const transcriptBase = {
    transcriptItemId: 'transcript-1',
    threadId: 'thread-1',
    runId: 'run-1',
    createdAt: at,
  } as const;
  for (const [kind, payload] of [
    ['input', { input: inputItem }],
    [
      'assistant',
      { status: 'completed', content: 'complete', finishReason: 'stop' },
    ],
    [
      'tool',
      { toolExecutionId: 'tool-execution-1', content: { result: 'fixture' } },
    ],
    ['system', { content: 'Fixture system message' }],
    [
      'operation',
      { operationId: 'operation-1', status: 'executing', content: 'Fixture' },
    ],
  ] as const) {
    add(`union.TranscriptItemView.${kind}`, 'schema:TranscriptItemView', {
      ...transcriptBase,
      kind,
      payload,
    });
  }
  const assistantBufferBase = {
    transcriptItemId: 'transcript-1',
    runId: 'run-1',
    incarnationId: 'incarnation-1',
    lastStreamSequence: '42',
    text: 'Fixture partial text',
  } as const;
  const toolBufferBase = {
    toolExecutionId: 'tool-execution-1',
    runId: 'run-1',
    incarnationId: 'incarnation-1',
    lastStreamSequence: '43',
    content: { stdout: 'Fixture partial output' },
  } as const;
  for (const [status, terminalAt, interruptionReason] of [
    ['streaming', null, null],
    ['completed', at, null],
    ['interrupted', at, 'stopped'],
  ] as const) {
    add(
      `union.AssistantStreamBuffer.${status}`,
      'schema:AssistantStreamBuffer',
      { ...assistantBufferBase, status, terminalAt, interruptionReason },
    );
    add(`union.ToolStreamBuffer.${status}`, 'schema:ToolStreamBuffer', {
      ...toolBufferBase,
      status,
      terminalAt,
      interruptionReason,
    });
  }
  for (const lifecycle of ['available', 'archived', 'deleted'] as const) {
    add(`union.ThreadView.${lifecycle}`, 'schema:ThreadView', {
      ...thread,
      lifecycle,
    });
  }

  add(
    'unknown.durable.non-critical',
    'schema:ThreadStreamFrame',
    unknownDurable,
    'accept',
    'unknownNonCritical',
  );
  add(
    'unknown.transient.non-critical',
    'schema:ThreadStreamFrame',
    unknownTransient,
    'accept',
    'unknownNonCritical',
  );
  add(
    'unknown.critical',
    'schema:ThreadStreamFrame',
    { ...unknownDurable, eventId: 'event-critical', critical: true },
    'accept',
    'resetRequired',
  );
  add(
    'union.UnknownEventEnvelope.durable',
    'schema:UnknownEventEnvelope',
    unknownDurable,
    'accept',
    'unknownNonCritical',
  );
  add(
    'union.UnknownEventEnvelope.transient',
    'schema:UnknownEventEnvelope',
    unknownTransient,
    'accept',
    'unknownNonCritical',
  );

  const durablePayloads = [
    ['thread.updated', thread],
    ['thread.lifecycleChanged', thread],
    ['run.statusChanged', run],
    ['queue.changed', snapshot.queue],
    [
      'operation.completed',
      { ...operationTerminalBase, status: 'completed', completedAt: at },
    ],
    [
      'operation.failed',
      {
        ...operationTerminalBase,
        status: 'failed',
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Fixture operation failed',
          retryable: false,
        },
      },
    ],
    [
      'operation.cancelled',
      {
        ...operationTerminalBase,
        status: 'cancelled',
        reason: 'Fixture cancellation',
        cancelledAt: at,
      },
    ],
    ['approval.requested', approval],
    [
      'approval.resolved',
      {
        ...approval,
        status: 'approved',
        decision: { decision: 'approve', reason: 'Fixture approval' },
        decidedAt: at,
      },
    ],
    ['approval.expired', { ...approval, status: 'expired' }],
    ['tool.terminal', toolExecution],
    [
      'credential.revoked',
      {
        credentialRef: 'credential-ref-1',
        provider: 'fixture-provider',
        revokedAt: at,
        reason: 'Fixture revocation',
      },
    ],
  ] as const;
  for (const [kind, payload] of durablePayloads) {
    add(
      `union.KnownDurableEventPayload.${kind}`,
      'schema:KnownDurableEventPayload',
      { kind, payload },
    );
    add(
      `union.KnownDurableEventEnvelope.${kind}`,
      'schema:KnownDurableEventEnvelope',
      {
        eventId: `event-${kind}`,
        threadId: 'thread-1',
        kind,
        critical: false,
        occurredAt: at,
        payload,
        durability: 'durable',
        durableSequence: '41',
      },
      'accept',
      'known',
    );
  }
  const transientPayloads = [
    [
      'assistant.textDelta',
      { transcriptItemId: 'transcript-1', chunk: 'Fixture text' },
    ],
    [
      'assistant.reasoningDelta',
      { transcriptItemId: 'transcript-1', chunk: 'Fixture reasoning' },
    ],
    [
      'tool.stdoutDelta',
      { toolExecutionId: 'tool-execution-1', chunk: 'Fixture stdout' },
    ],
    [
      'tool.stderrDelta',
      { toolExecutionId: 'tool-execution-1', chunk: 'Fixture stderr' },
    ],
    [
      'operation.progressDelta',
      { operationId: 'operation-1', progress: { phase: 'fixture' } },
    ],
  ] as const;
  for (const [kind, payload] of transientPayloads) {
    add(
      `union.KnownTransientEventPayload.${kind}`,
      'schema:KnownTransientEventPayload',
      { kind, payload },
    );
    add(
      `union.KnownTransientEventEnvelope.${kind}`,
      'schema:KnownTransientEventEnvelope',
      {
        eventId: `event-${kind}`,
        threadId: 'thread-1',
        kind,
        critical: false,
        occurredAt: at,
        payload,
        durability: 'transient',
        incarnationId: 'incarnation-1',
        streamSequence: '43',
        durableBasis: '41',
      },
      'accept',
      'known',
    );
  }
  add(
    'known-event.malformed.protocol-error',
    'schema:ThreadStreamFrame',
    {
      eventId: 'event-malformed-known',
      threadId: 'thread-1',
      kind: 'thread.updated',
      critical: false,
      occurredAt: at,
      payload: {},
      durability: 'durable',
      durableSequence: '42',
    },
    'reject',
    'protocolError',
  );

  const ack = {
    commandId: 'command-1',
    status: 'accepted',
    replayed: false,
    threadId: 'thread-1',
    currentDurableCursor: '41',
    acceptedAt: at,
  } as const;
  add('command-ack.original', 'http:thread.delete:result', ack);
  add('command-ack.replayed', 'http:thread.delete:result', {
    ...ack,
    replayed: true,
  });

  const durableReset = {
    kind: 'stream.snapshotReset',
    resetId: 'reset-1',
    threadId: 'thread-1',
    reason: 'runtimeNotLoaded',
    snapshot,
    durableCursor: '41',
  } as const;
  add(
    'snapshot-reset.without-runtime',
    'schema:SnapshotReset',
    durableReset,
    'accept',
    'known',
  );
  add(
    'snapshot-reset.with-runtime',
    'schema:SnapshotReset',
    {
      ...durableReset,
      reason: 'cursorExpired',
      snapshot: {
        ...snapshot,
        incarnationId: 'incarnation-1',
        streamCursor: '43',
        streamState: {
          assistantBuffers: [
            {
              transcriptItemId: 'transcript-1',
              runId: 'run-1',
              incarnationId: 'incarnation-1',
              lastStreamSequence: '42',
              text: 'Fixture partial text',
              status: 'streaming',
              terminalAt: null,
              interruptionReason: null,
            },
          ],
          toolBuffers: [
            {
              toolExecutionId: 'tool-execution-1',
              runId: 'run-1',
              incarnationId: 'incarnation-1',
              lastStreamSequence: '43',
              content: { stdout: 'Fixture partial output' },
              status: 'streaming',
              terminalAt: null,
              interruptionReason: null,
            },
          ],
        },
      },
      incarnationId: 'incarnation-1',
      streamCursor: '43',
    },
    'accept',
    'known',
  );
  add(
    'union.ParseThreadStreamFrameResult.known',
    'schema:ParseThreadStreamFrameResult',
    { outcome: 'known', frame: durableReset },
  );
  add(
    'union.ParseThreadStreamFrameResult.unknownNonCritical',
    'schema:ParseThreadStreamFrameResult',
    { outcome: 'unknownNonCritical', frame: unknownDurable },
  );
  add(
    'union.ParseThreadStreamFrameResult.resetRequired',
    'schema:ParseThreadStreamFrameResult',
    {
      outcome: 'resetRequired',
      reason: 'criticalUnknownEvent',
      eventId: 'event-critical',
      kind: 'plugin.futureDurable',
    },
  );
  add(
    'union.ParseThreadStreamFrameResult.protocolError',
    'schema:ParseThreadStreamFrameResult',
    {
      outcome: 'protocolError',
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Invalid thread stream frame',
        retryable: false,
      },
    },
  );
  add('credential-ref', 'schema:CredentialRef', {
    credentialRef: 'credential-ref-1',
    provider: 'fixture-provider',
    label: 'Fixture credential',
    createdAt: at,
  });

  for (const code of (resolveFixtureSchema('schema:ErrorCode') as z.ZodEnum)
    .options) {
    add(`api-error.${code}`, 'schema:ApiError', {
      error: { code, message: `Fixture ${code}`, retryable: false },
    });
  }
  add(
    'reject.nested-secret',
    'schema:ConfigPatch',
    {
      providerOptions: { nested: [{ secret: 'not-a-secret-value' }] },
    },
    'reject',
  );
  add(
    'reject.unknown-top-level',
    'schema:HealthResponse',
    {
      status: 'ok',
      unknown: true,
    },
    'reject',
  );
  add(
    'reject.unknown-nested',
    'schema:ApiError',
    {
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Fixture validation failure',
        retryable: false,
        unknown: true,
      },
    },
    'reject',
  );
  return cases;
};

const existingCatalogFiles = (root: string): ReadonlySet<string> => {
  const files = new Set<string>();
  const visit = (directory: string, prefix: string): void => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const relativePath = `${prefix}/${name}`;
      const metadata = lstatSync(path);
      if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
        visit(path, relativePath);
      } else if (metadata.isFile() && !metadata.isSymbolicLink()) {
        files.add(relativePath);
      } else {
        throw new TypeError(`unmanaged golden fixture path: ${relativePath}`);
      }
    }
  };
  for (const directory of ['valid', 'invalid']) {
    const path = join(root, directory);
    try {
      const metadata = lstatSync(path);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw new TypeError(`unmanaged golden fixture path: ${directory}`);
      }
      visit(path, directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  for (const name of readdirSync(root)) {
    if (
      name === 'manifest.json' ||
      name === 'valid' ||
      name === 'invalid' ||
      name.startsWith('.schema-generation.')
    ) {
      continue;
    }
    throw new TypeError(`unmanaged golden fixture path: ${name}`);
  }
  return files;
};

const assertNoOrphanedCatalogFiles = (
  root: string,
  nextFiles: ReadonlySet<string>,
): void => {
  let priorEntries: FixtureManifestEntry[] = [];
  let manifestSource: string | undefined;
  try {
    manifestSource = readFileSync(join(root, 'manifest.json'), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (manifestSource !== undefined) {
    try {
      priorEntries = fixtureManifestSchema.parse(JSON.parse(manifestSource));
      validateManifestPaths(priorEntries, root);
    } catch {
      throw new TypeError('golden fixture manifest is malformed');
    }
  }
  const actualFiles = existingCatalogFiles(root);
  const declaredFiles = new Set(priorEntries.map(({ file }) => file));
  const orphan = [...actualFiles].find((file) => !declaredFiles.has(file));
  const retired = [...declaredFiles].find((file) => !nextFiles.has(file));
  const unsafe = orphan ?? retired;
  if (unsafe !== undefined) {
    throw new TypeError(`unmanaged golden fixture path: ${unsafe}`);
  }
};

export const generateFixtureCatalog = async (
  goldenRoot: string,
): Promise<void> => {
  const destination = resolve(goldenRoot);
  const rootMetadata = lstatSync(destination);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new TypeError('golden root must be a real directory');
  }
  const cases = createAuthoredCases().sort((left, right) =>
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
  );
  const manifest = cases.map(
    ({ expect, expectedOutcome, file, id, schema }): FixtureManifestEntry => ({
      expect,
      ...(expectedOutcome === undefined ? {} : { expectedOutcome }),
      file,
      id,
      schema,
    }),
  );
  validateManifestPaths(manifest, destination);
  const outputs: Record<string, string> = Object.fromEntries([
    ['manifest.json', stableJson(manifest)],
    ...cases.map(({ file, value }) => [file, stableJson(value)] as const),
  ]);
  await publishGeneratedOutputs(destination, outputs, {
    preflightUnderLock: () =>
      assertNoOrphanedCatalogFiles(destination, new Set(Object.keys(outputs))),
  });
};

if (import.meta.main)
  await generateFixtureCatalog(resolve(import.meta.dir, '../fixtures/golden'));
