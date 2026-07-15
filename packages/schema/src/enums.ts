import { z } from 'zod';

export const threadLifecycleSchema = z.enum([
  'available',
  'archived',
  'deleted',
]);
export type ThreadLifecycle = z.infer<typeof threadLifecycleSchema>;

export const threadRuntimeStatusSchema = z.enum([
  'notLoaded',
  'loading',
  'idle',
  'running',
  'recovering',
  'blocked',
]);
export type ThreadRuntimeStatus = z.infer<typeof threadRuntimeStatusSchema>;

export const runStatusSchema = z.enum([
  'starting',
  'running',
  'steering',
  'stopping',
  'recovering',
  'blocked',
  'completed',
  'failed',
  'stopped',
]);
export type RunStatus = z.infer<typeof runStatusSchema>;

export const runKindSchema = z.enum(['interactive', 'checkpointApply']);
export type RunKind = z.infer<typeof runKindSchema>;

const queueControlStates = [
  'active',
  'pausedByUser',
  'pausedByStop',
  'pausedByFailure',
] as const;

export const queueControlStateSchema = z.enum(queueControlStates);
export type QueueControlState = z.infer<typeof queueControlStateSchema>;

export const effectiveQueueDispatchStateSchema = z.enum([
  ...queueControlStates,
  'blockedByIndeterminate',
]);
export type EffectiveQueueDispatchState = z.infer<
  typeof effectiveQueueDispatchStateSchema
>;

export const queueItemStatusSchema = z.enum(['queued', 'consumed', 'removed']);
export type QueueItemStatus = z.infer<typeof queueItemStatusSchema>;

export const operationStatusSchema = z.enum([
  'accepted',
  'executing',
  'waiting',
  'blocked',
  'completed',
  'failed',
  'cancelled',
]);
export type OperationStatus = z.infer<typeof operationStatusSchema>;

export const operationKindSchema = z.enum([
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
]);
export type OperationKind = z.infer<typeof operationKindSchema>;

export const approvalStatusSchema = z.enum([
  'pending',
  'approved',
  'denied',
  'expired',
  'cancelled',
]);
export type ApprovalStatus = z.infer<typeof approvalStatusSchema>;

export const approvalKindSchema = z.enum([
  'toolExecution',
  'workspaceMutation',
  'networkAccess',
  'credentialUse',
]);
export type ApprovalKind = z.infer<typeof approvalKindSchema>;

export const approvalDecisionSchema = z.enum(['approve', 'deny']);
export type ApprovalDecision = z.infer<typeof approvalDecisionSchema>;

export const toolExecutionStateSchema = z.enum([
  'scheduled',
  'running',
  'cancelRequested',
  'completed',
  'failed',
  'cancelled',
  'indeterminate',
]);
export type ToolExecutionState = z.infer<typeof toolExecutionStateSchema>;

export const inputRoleSchema = z.enum(['user', 'system']);
export type InputRole = z.infer<typeof inputRoleSchema>;

export const inputSourceSchema = z.enum([
  'submission',
  'steer',
  'automation',
  'recovery',
  'checkpointApply',
]);
export type InputSource = z.infer<typeof inputSourceSchema>;

export const transcriptItemKindSchema = z.enum([
  'input',
  'assistant',
  'tool',
  'system',
  'operation',
]);
export type TranscriptItemKind = z.infer<typeof transcriptItemKindSchema>;

export const transcriptStatusSchema = z.enum([
  'streaming',
  'interrupted',
  'completed',
]);
export type TranscriptStatus = z.infer<typeof transcriptStatusSchema>;

export const submissionDispositionSchema = z.enum([
  'auto',
  'enqueue',
  'requireImmediate',
]);
export type SubmissionDisposition = z.infer<typeof submissionDispositionSchema>;

export const steerStalePolicySchema = z.enum(['reject', 'enqueue']);
export type SteerStalePolicy = z.infer<typeof steerStalePolicySchema>;

export const streamStateStatusSchema = z.enum([
  'streaming',
  'interrupted',
  'completed',
]);
export type StreamStateStatus = z.infer<typeof streamStateStatusSchema>;

export const streamInterruptionReasonSchema = z.enum([
  'steered',
  'stopped',
  'daemonLost',
  'streamStateUnavailable',
]);
export type StreamInterruptionReason = z.infer<
  typeof streamInterruptionReasonSchema
>;
