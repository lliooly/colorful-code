import { z } from 'zod';

import {
  approvalIdSchema,
  artifactIdSchema,
  checkpointIdSchema,
  commandIdSchema,
  contextBoundaryIdSchema,
  credentialRefIdSchema,
  daemonInstanceIdSchema,
  eventIdSchema,
  incarnationIdSchema,
  inputItemIdSchema,
  lineageIdSchema,
  operationIdSchema,
  pluginIdSchema,
  principalIdSchema,
  queueItemIdSchema,
  resetIdSchema,
  runIdSchema,
  threadIdSchema,
  toolExecutionIdSchema,
  transcriptItemIdSchema,
  workspaceIdSchema,
} from '../src/ids.js';

type IdTypes = {
  ThreadId: z.infer<typeof threadIdSchema>;
  LineageId: z.infer<typeof lineageIdSchema>;
  RunId: z.infer<typeof runIdSchema>;
  QueueItemId: z.infer<typeof queueItemIdSchema>;
  InputItemId: z.infer<typeof inputItemIdSchema>;
  TranscriptItemId: z.infer<typeof transcriptItemIdSchema>;
  OperationId: z.infer<typeof operationIdSchema>;
  ApprovalId: z.infer<typeof approvalIdSchema>;
  ToolExecutionId: z.infer<typeof toolExecutionIdSchema>;
  CheckpointId: z.infer<typeof checkpointIdSchema>;
  ContextBoundaryId: z.infer<typeof contextBoundaryIdSchema>;
  EventId: z.infer<typeof eventIdSchema>;
  ResetId: z.infer<typeof resetIdSchema>;
  IncarnationId: z.infer<typeof incarnationIdSchema>;
  CommandId: z.infer<typeof commandIdSchema>;
  CredentialRefId: z.infer<typeof credentialRefIdSchema>;
  DaemonInstanceId: z.infer<typeof daemonInstanceIdSchema>;
  ArtifactId: z.infer<typeof artifactIdSchema>;
  WorkspaceId: z.infer<typeof workspaceIdSchema>;
  PrincipalId: z.infer<typeof principalIdSchema>;
  PluginId: z.infer<typeof pluginIdSchema>;
};

type OtherIdNames<IdName extends keyof IdTypes> = Exclude<
  keyof IdTypes,
  IdName
>;

type AssignableIdPairs = {
  [LeftName in keyof IdTypes]: {
    [RightName in OtherIdNames<LeftName>]: IdTypes[LeftName] extends IdTypes[RightName]
      ? `${LeftName}->${RightName}`
      : never;
  }[OtherIdNames<LeftName>];
}[keyof IdTypes];

type ExpectNever<Type extends never> = Type;

export type AllIdBrandsArePairwiseNonAssignable =
  ExpectNever<AssignableIdPairs>;
