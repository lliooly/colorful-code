import { z } from 'zod';

const idSchema = <Brand extends string>() =>
  z.string().trim().min(1).brand<Brand>();

export const threadIdSchema = idSchema<'ThreadId'>();
export type ThreadId = z.infer<typeof threadIdSchema>;

export const lineageIdSchema = idSchema<'LineageId'>();
export type LineageId = z.infer<typeof lineageIdSchema>;

export const runIdSchema = idSchema<'RunId'>();
export type RunId = z.infer<typeof runIdSchema>;

export const queueItemIdSchema = idSchema<'QueueItemId'>();
export type QueueItemId = z.infer<typeof queueItemIdSchema>;

export const inputItemIdSchema = idSchema<'InputItemId'>();
export type InputItemId = z.infer<typeof inputItemIdSchema>;

export const transcriptItemIdSchema = idSchema<'TranscriptItemId'>();
export type TranscriptItemId = z.infer<typeof transcriptItemIdSchema>;

export const operationIdSchema = idSchema<'OperationId'>();
export type OperationId = z.infer<typeof operationIdSchema>;

export const approvalIdSchema = idSchema<'ApprovalId'>();
export type ApprovalId = z.infer<typeof approvalIdSchema>;

export const toolExecutionIdSchema = idSchema<'ToolExecutionId'>();
export type ToolExecutionId = z.infer<typeof toolExecutionIdSchema>;

export const checkpointIdSchema = idSchema<'CheckpointId'>();
export type CheckpointId = z.infer<typeof checkpointIdSchema>;

export const contextBoundaryIdSchema = idSchema<'ContextBoundaryId'>();
export type ContextBoundaryId = z.infer<typeof contextBoundaryIdSchema>;

export const eventIdSchema = idSchema<'EventId'>();
export type EventId = z.infer<typeof eventIdSchema>;

export const resetIdSchema = idSchema<'ResetId'>();
export type ResetId = z.infer<typeof resetIdSchema>;

export const incarnationIdSchema = idSchema<'IncarnationId'>();
export type IncarnationId = z.infer<typeof incarnationIdSchema>;

export const commandIdSchema = idSchema<'CommandId'>();
export type CommandId = z.infer<typeof commandIdSchema>;

export const credentialRefIdSchema = idSchema<'CredentialRefId'>();
export type CredentialRefId = z.infer<typeof credentialRefIdSchema>;

export const daemonInstanceIdSchema = idSchema<'DaemonInstanceId'>();
export type DaemonInstanceId = z.infer<typeof daemonInstanceIdSchema>;

export const artifactIdSchema = idSchema<'ArtifactId'>();
export type ArtifactId = z.infer<typeof artifactIdSchema>;

export const workspaceIdSchema = idSchema<'WorkspaceId'>();
export type WorkspaceId = z.infer<typeof workspaceIdSchema>;

export const principalIdSchema = idSchema<'PrincipalId'>();
export type PrincipalId = z.infer<typeof principalIdSchema>;

export const pluginIdSchema = idSchema<'PluginId'>();
export type PluginId = z.infer<typeof pluginIdSchema>;
