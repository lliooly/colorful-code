import { describe, expect, test } from 'bun:test';

import * as enums from '@colorful-code/schema/enums';

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
