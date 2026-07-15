import { describe, expect, test } from 'bun:test';

import * as enums from '@colorful-code/schema/enums';
import { errorCodeSchema } from '@colorful-code/schema/errors';

const enumCases = {
  threadLifecycleSchema: ['available', 'archived', 'deleted'],
  threadRuntimeStatusSchema: [
    'notLoaded',
    'loading',
    'idle',
    'running',
    'recovering',
    'blocked',
  ],
  runStatusSchema: [
    'starting',
    'running',
    'steering',
    'stopping',
    'recovering',
    'blocked',
    'completed',
    'failed',
    'stopped',
  ],
  runKindSchema: ['interactive', 'checkpointApply'],
  queueControlStateSchema: [
    'active',
    'pausedByUser',
    'pausedByStop',
    'pausedByFailure',
  ],
  effectiveQueueDispatchStateSchema: [
    'active',
    'pausedByUser',
    'pausedByStop',
    'pausedByFailure',
    'blockedByIndeterminate',
  ],
  queueItemStatusSchema: ['queued', 'consumed', 'removed'],
  operationStatusSchema: [
    'accepted',
    'executing',
    'waiting',
    'blocked',
    'completed',
    'failed',
    'cancelled',
  ],
  operationKindSchema: [
    'steer',
    'stop',
    'checkpointApply',
    'compaction',
    'policyReconcile',
    'threadResume',
    'threadUndelete',
    'threadArchive',
    'threadDelete',
    'lateObservationReconcile',
    'modelInvocation',
    'toolInvocation',
  ],
  approvalStatusSchema: [
    'pending',
    'approved',
    'denied',
    'expired',
    'cancelled',
  ],
  approvalKindSchema: [
    'toolExecution',
    'workspaceMutation',
    'networkAccess',
    'credentialUse',
  ],
  approvalDecisionSchema: ['approve', 'deny'],
  toolExecutionStateSchema: [
    'scheduled',
    'running',
    'cancelRequested',
    'completed',
    'failed',
    'cancelled',
    'indeterminate',
  ],
  inputRoleSchema: ['user', 'system'],
  inputSourceSchema: [
    'submission',
    'steer',
    'automation',
    'recovery',
    'checkpointApply',
  ],
  transcriptItemKindSchema: [
    'input',
    'assistant',
    'tool',
    'system',
    'operation',
  ],
  transcriptStatusSchema: ['streaming', 'interrupted', 'completed'],
  submissionDispositionSchema: ['auto', 'enqueue', 'requireImmediate'],
  steerStalePolicySchema: ['reject', 'enqueue'],
  streamStateStatusSchema: ['streaming', 'interrupted', 'completed'],
  streamInterruptionReasonSchema: [
    'steered',
    'stopped',
    'daemonLost',
    'streamStateUnavailable',
  ],
} as const;

describe('public enum schemas', () => {
  for (const [schemaName, expectedValues] of Object.entries(enumCases)) {
    test(`${schemaName} exposes exactly its declared values`, () => {
      const schema = enums[schemaName as keyof typeof enums];

      expect(schema).toBeDefined();
      expect('options' in schema ? schema.options : undefined).toEqual(
        expectedValues,
      );
      for (const value of expectedValues) {
        expect(schema.safeParse(value).success).toBe(true);
      }
      for (const invalid of [
        'UNKNOWN',
        'unknown',
        expectedValues[0].toUpperCase(),
      ]) {
        expect(schema.safeParse(invalid).success).toBe(false);
      }
    });
  }
});

describe('errorCodeSchema', () => {
  const errorCodes = [
    'VALIDATION_ERROR',
    'THREAD_NOT_FOUND',
    'THREAD_ARCHIVED',
    'THREAD_DELETED',
    'THREAD_PURGE_STARTED',
    'THREAD_NOT_IMMEDIATELY_RUNNABLE',
    'RUN_NOT_FOUND',
    'RUN_NOT_ACTIVE',
    'RUN_ALREADY_TERMINAL',
    'STALE_PLAN_GENERATION',
    'STALE_INCARNATION',
    'QUEUE_ITEM_NOT_FOUND',
    'QUEUE_ITEM_ALREADY_CONSUMED',
    'QUEUE_REVISION_CONFLICT',
    'COMMAND_ID_CONFLICT',
    'APPROVAL_EXPIRED',
    'OPERATION_CONFLICT',
    'CONFIG_REVISION_CONFLICT',
    'POLICY_REVISION_CONFLICT',
    'RUNTIME_DRAINING',
    'RECOVERY_BLOCKED',
    'INDETERMINATE_SIDE_EFFECT',
    'AUTHENTICATION_REQUIRED',
    'CREDENTIAL_UNAVAILABLE',
    'INTERNAL_ERROR',
  ] as const;

  test('exposes exactly the 25 stable codes', () => {
    expect(errorCodeSchema.options).toEqual(errorCodes);
    for (const code of errorCodes) {
      expect(errorCodeSchema.safeParse(code).success).toBe(true);
    }
  });

  test('rejects unknown and case-changed codes', () => {
    expect(errorCodeSchema.safeParse('UNKNOWN_ERROR').success).toBe(false);
    expect(errorCodeSchema.safeParse('validation_error').success).toBe(false);
  });
});
