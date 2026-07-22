import type { z } from 'zod';

const GENERATED_HEADER = '// This file is generated. Do not edit.\n';

const SCHEMAS_BY_AUTHORING_MODULE = {
  ack: ['CommandAck'],
  auth: [
    'AuthenticatedPrincipal',
    'AuthenticatedPrincipalKind',
    'DaemonDiscovery',
    'DaemonEndpoint',
    'TokenRef',
  ],
  commands: [
    'ApplyCheckpointBody',
    'ApprovalDecisionBody',
    'ApprovalDecisionPath',
    'CheckpointPage',
    'CheckpointPath',
    'CheckpointSummary',
    'ConfigChangeBody',
    'CreateSubmissionBody',
    'CreateThreadBody',
    'EmptyQuery',
    'EventAttachAcceptedResponse',
    'EventAttachParams',
    'EventAttachQuery',
    'EventAttachResetResponse',
    'EventAttachResponse',
    'ForkBoundary',
    'ForkThreadBody',
    'NewInputItem',
    'OperationListQuery',
    'OperationPage',
    'OperationPath',
    'PaginationQuery',
    'PatchQueueItemBody',
    'PatchQueueItemResult',
    'PatchThreadBody',
    'PolicyChangeBody',
    'QueueItemPath',
    'QueueMutationBody',
    'QueueRevisionResult',
    'ReorderQueueBody',
    'RunPage',
    'RunPath',
    'SteerRunBody',
    'StopRunBody',
    'SubmissionResult',
    'ThreadLifecycleBody',
    'ThreadMetadataPatch',
    'ThreadPage',
    'ThreadPath',
    'UndefinedResult',
  ],
  common: [
    'CanonicalNonBlankString',
    'ConfigRevision',
    'DurableCursor',
    'HealthResponse',
    'JsonObject',
    'JsonValue',
    'PageCursor',
    'PageInfo',
    'PlanGeneration',
    'PolicyRevision',
    'Revision',
    'StreamCursor',
    'Timestamp',
  ],
  config: [
    'ConfigPatch',
    'ConfigRevisionResult',
    'CredentialRef',
    'ReasoningEffort',
  ],
  enums: [
    'ApprovalDecision',
    'ApprovalKind',
    'ApprovalStatus',
    'EffectiveQueueDispatchState',
    'InputRole',
    'InputSource',
    'OperationCompletionEventKind',
    'OperationKind',
    'OperationStatus',
    'QueueControlState',
    'QueueItemStatus',
    'RunKind',
    'RunStatus',
    'SteerStalePolicy',
    'StreamInterruptionReason',
    'StreamStateStatus',
    'SubmissionDisposition',
    'ThreadLifecycle',
    'ThreadRuntimeStatus',
    'ToolExecutionState',
    'TranscriptItemKind',
    'TranscriptStatus',
  ],
  errors: ['ApiError', 'ApiErrorPayload', 'ErrorCode', 'ErrorHttpMapping'],
  events: [
    'CredentialRevokedEventPayload',
    'DurableBasis',
    'EventBase',
    'KnownDurableEventEnvelope',
    'KnownDurableEventPayload',
    'KnownThreadStreamFrame',
    'KnownTransientEventEnvelope',
    'KnownTransientEventPayload',
    'ParseThreadStreamFrameResult',
    'StreamBasis',
    'ThreadStreamFrame',
    'UnknownDurableEventEnvelope',
    'UnknownEventEnvelope',
    'UnknownTransientEventEnvelope',
  ],
  ids: [
    'ApprovalId',
    'ArtifactId',
    'CheckpointId',
    'CommandId',
    'ContextBoundaryId',
    'CredentialRefId',
    'DaemonInstanceId',
    'EventId',
    'IncarnationId',
    'InputItemId',
    'LineageId',
    'OperationId',
    'PluginId',
    'PrincipalId',
    'QueueItemId',
    'ResetId',
    'RunId',
    'ThreadId',
    'ToolExecutionId',
    'TranscriptItemId',
    'WorkspaceId',
  ],
  operations: [
    'ApprovalDecisionView',
    'ApprovalView',
    'ArtifactReference',
    'OperationCancelledEventPayload',
    'OperationCompletedEventPayload',
    'OperationFailedEventPayload',
    'OperationProgress',
    'OperationTerminalEventPayload',
    'OperationView',
    'ToolExecutionSummary',
  ],
  policy: [
    'NetworkPolicy',
    'PluginCapabilities',
    'PolicyPatch',
    'PolicyRevisionResult',
    'SandboxPolicy',
  ],
  queue: [
    'AssistantTranscriptPayload',
    'CompletedAssistantTranscriptPayload',
    'InputTranscriptPayload',
    'InterruptedAssistantTranscriptPayload',
    'OperationTranscriptPayload',
    'QueueItemView',
    'QueueView',
    'StreamingAssistantTranscriptPayload',
    'SystemTranscriptPayload',
    'ToolTranscriptPayload',
    'TranscriptItemView',
  ],
  run: ['RunTerminalReason', 'RunView'],
  snapshot: [
    'AssistantStreamBuffer',
    'SnapshotReset',
    'SnapshotResetKind',
    'SnapshotResetReason',
    'StreamStateSnapshot',
    'ThreadSnapshot',
    'ToolStreamBuffer',
  ],
  thread: [
    'ArtifactReferencesInputContent',
    'InputContent',
    'InputItemView',
    'StructuredInputContent',
    'TextInputContent',
    'ThreadView',
    'WorkspaceBinding',
    'WorkspaceTrust',
  ],
} as const;

const compareText = (left: string, right: string) =>
  left < right ? -1 : left > right ? 1 : 0;

const moduleBySchema = new Map<string, string>();
for (const [moduleName, names] of Object.entries(SCHEMAS_BY_AUTHORING_MODULE)) {
  for (const name of names) {
    if (moduleBySchema.has(name)) {
      throw new TypeError(`duplicate authoring module mapping for ${name}`);
    }
    moduleBySchema.set(name, moduleName);
  }
}

const schemaIdentifier = (name: string) =>
  name === 'CommandAck'
    ? 'commandAckWithoutResultSchema'
    : `${name.slice(0, 1).toLowerCase()}${name.slice(1)}Schema`;

export const createTypeScriptContracts = (
  schemas: Readonly<Record<string, z.ZodType>>,
): string => {
  const names = Object.keys(schemas).sort(compareText);
  const entries = names.map((name) => {
    const moduleName = moduleBySchema.get(name);
    if (moduleName === undefined) {
      throw new TypeError(`unmapped registry schema: ${name}`);
    }
    return { moduleName, name, validator: schemaIdentifier(name) };
  });

  return [
    GENERATED_HEADER,
    "import { z } from 'zod';",
    '',
    ...entries.map(
      ({ moduleName, validator }) =>
        `import { ${validator} } from '../../src/${moduleName}.js';`,
    ),
    '',
    ...entries.map(
      ({ moduleName, validator }) =>
        `export { ${validator} } from '../../src/${moduleName}.js';`,
    ),
    '',
    ...entries.map(
      ({ name, validator }) =>
        `export type ${name} = z.infer<typeof ${validator}>;`,
    ),
    '',
  ].join('\n');
};
