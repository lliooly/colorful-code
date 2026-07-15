import { describe, expect, test } from 'bun:test';

import {
  approvalViewSchema,
  operationViewSchema,
  toolExecutionSummarySchema,
} from '@colorful-code/schema/operations';

const at = '2026-07-15T10:00:00+08:00';
const operation = {
  operationId: 'op-1',
  threadId: 'thread-1',
  kind: 'steer',
  status: 'waiting',
  phase: 'awaiting-runtime',
  parentOperationId: null,
  runId: 'run-1',
  expectedPlanGeneration: 1,
  appliedPlanGeneration: null,
  targetConfigRevision: 2,
  appliedConfigRevision: null,
  targetPolicyRevision: 3,
  appliedPolicyRevision: null,
  progress: {
    phase: 'waiting',
    completedUnits: 1,
    totalUnits: 2,
    message: 'waiting',
  },
  result: null,
  error: null,
  revision: 4,
  createdAt: at,
  updatedAt: at,
  completedAt: null,
};

describe('OperationView', () => {
  test('accepts bounded public progress and required nullable fences', () => {
    expect(operationViewSchema.parse(operation)).toEqual(operation);
  });
  test('rejects coordination, ledger and snapshot internals', () => {
    for (const field of [
      'payloadHash',
      'acceptedLedgerSequence',
      'coordinationCycleId',
      'snapshotJson',
      'leaseEpoch',
      'workerId',
    ]) {
      expect(
        operationViewSchema.safeParse({ ...operation, [field]: 'internal' })
          .success,
      ).toBe(false);
    }
  });
});

describe('ApprovalView and ToolExecutionSummary', () => {
  const approval = {
    approvalId: 'approval-1',
    threadId: 'thread-1',
    runId: 'run-1',
    kind: 'toolExecution',
    status: 'pending',
    planGeneration: 1,
    policyRevision: 2,
    requestSummary: { tool: 'write' },
    decision: null,
    revision: 1,
    createdAt: at,
    updatedAt: at,
    decidedAt: null,
    expiresAt: null,
  };
  const tool = {
    toolExecutionId: 'tool-1',
    threadId: 'thread-1',
    runId: 'run-1',
    toolName: 'write_file',
    state: 'completed',
    planGeneration: 1,
    policyRevision: 2,
    redactedSummary: { changedFiles: 1 },
    artifacts: [
      {
        artifactId: 'artifact-1',
        mediaType: 'text/plain',
        byteLength: 4,
        label: 'result',
      },
    ],
    createdAt: at,
    updatedAt: at,
    completedAt: at,
  };
  test('parses bounded public projections', () => {
    expect(approvalViewSchema.parse(approval)).toEqual(approval);
    expect(toolExecutionSummarySchema.parse(tool)).toEqual(tool);
  });
  test('rejects ownership, permit, attempt, routing and raw output internals', () => {
    for (const field of [
      'leaseEpoch',
      'ownerIncarnationId',
      'arguments',
      'idempotencyKey',
      'permitId',
      'attemptId',
      'workerId',
      'rawStdout',
      'rawStderr',
    ]) {
      expect(
        approvalViewSchema.safeParse({ ...approval, [field]: 'internal' })
          .success,
      ).toBe(false);
      expect(
        toolExecutionSummarySchema.safeParse({ ...tool, [field]: 'internal' })
          .success,
      ).toBe(false);
    }
  });
});
