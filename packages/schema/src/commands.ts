import { z } from 'zod';

import {
  configRevisionSchema,
  durableCursorSchema,
  pageCursorSchema,
  pageSchema,
  planGenerationSchema,
  policyRevisionSchema,
  revisionSchema,
  streamCursorSchema,
  strictObjectSchema,
  timestampSchema,
} from './common.js';
import { configPatchSchema, configRevisionResultSchema } from './config.js';
import {
  approvalDecisionSchema,
  operationKindSchema,
  operationStatusSchema,
  steerStalePolicySchema,
  submissionDispositionSchema,
} from './enums.js';
import {
  approvalIdSchema,
  checkpointIdSchema,
  commandIdSchema,
  contextBoundaryIdSchema,
  incarnationIdSchema,
  inputItemIdSchema,
  operationIdSchema,
  queueItemIdSchema,
  runIdSchema,
  threadIdSchema,
} from './ids.js';
import { approvalViewSchema, operationViewSchema } from './operations.js';
import { policyPatchSchema, policyRevisionResultSchema } from './policy.js';
import { queueItemViewSchema, queueViewSchema } from './queue.js';
import { runViewSchema } from './run.js';
import { threadSnapshotSchema } from './snapshot.js';
import {
  inputContentSchema,
  threadViewSchema,
  workspaceBindingSchema,
} from './thread.js';

export const emptyQuerySchema = strictObjectSchema({});
export type EmptyQuery = z.infer<typeof emptyQuerySchema>;

export const paginationQuerySchema = strictObjectSchema({
  cursor: pageCursorSchema.optional(),
  limit: z.number().int().min(1).max(100).optional(),
});
export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

export const threadPathSchema = strictObjectSchema({
  threadId: threadIdSchema,
});
export type ThreadPath = z.infer<typeof threadPathSchema>;

export const threadPageSchema = pageSchema(threadViewSchema);
export type ThreadPage = z.infer<typeof threadPageSchema>;

const threadMetadataValueSchema = z.string().trim().min(1);

export const createThreadBodySchema = strictObjectSchema({
  commandId: commandIdSchema,
  title: threadMetadataValueSchema.optional(),
  goal: threadMetadataValueSchema.optional(),
  workspaceBinding: workspaceBindingSchema.optional(),
});
export type CreateThreadBody = z.infer<typeof createThreadBodySchema>;

export const threadMetadataPatchSchema = strictObjectSchema({
  title: threadMetadataValueSchema.optional(),
  goal: threadMetadataValueSchema.optional(),
}).refine(({ title, goal }) => title !== undefined || goal !== undefined, {
  message: 'at least one thread metadata field is required',
});
export type ThreadMetadataPatch = z.infer<typeof threadMetadataPatchSchema>;

export const patchThreadBodySchema = strictObjectSchema({
  commandId: commandIdSchema,
  expectedThreadRevision: revisionSchema,
  patch: threadMetadataPatchSchema,
});
export type PatchThreadBody = z.infer<typeof patchThreadBodySchema>;

export const threadLifecycleBodySchema = strictObjectSchema({
  commandId: commandIdSchema,
  expectedThreadRevision: revisionSchema,
});
export type ThreadLifecycleBody = z.infer<typeof threadLifecycleBodySchema>;

export const forkBoundarySchema = z.discriminatedUnion('kind', [
  strictObjectSchema({
    kind: z.literal('latestCommitted'),
  }),
  strictObjectSchema({
    kind: z.literal('contextBoundary'),
    contextBoundaryId: contextBoundaryIdSchema,
  }),
  strictObjectSchema({
    kind: z.literal('checkpoint'),
    checkpointId: checkpointIdSchema,
  }),
]);
export type ForkBoundary = z.infer<typeof forkBoundarySchema>;

export const forkThreadBodySchema = strictObjectSchema({
  commandId: commandIdSchema,
  expectedThreadRevision: revisionSchema,
  boundary: forkBoundarySchema,
});
export type ForkThreadBody = z.infer<typeof forkThreadBodySchema>;

export const runPathSchema = strictObjectSchema({
  threadId: threadIdSchema,
  runId: runIdSchema,
});
export type RunPath = z.infer<typeof runPathSchema>;

export const queueItemPathSchema = strictObjectSchema({
  threadId: threadIdSchema,
  queueItemId: queueItemIdSchema,
});
export type QueueItemPath = z.infer<typeof queueItemPathSchema>;

export const newInputItemSchema = strictObjectSchema({
  content: inputContentSchema,
});
export type NewInputItem = z.infer<typeof newInputItemSchema>;

export const createSubmissionBodySchema = strictObjectSchema({
  commandId: commandIdSchema,
  input: newInputItemSchema,
  disposition: submissionDispositionSchema,
});
export type CreateSubmissionBody = z.infer<typeof createSubmissionBodySchema>;

export const submissionResultSchema = z.discriminatedUnion('kind', [
  strictObjectSchema({
    kind: z.literal('runCreated'),
    inputItemId: inputItemIdSchema,
    runId: runIdSchema,
  }),
  strictObjectSchema({
    kind: z.literal('queueItemCreated'),
    inputItemId: inputItemIdSchema,
    queueItemId: queueItemIdSchema,
  }),
]);
export type SubmissionResult = z.infer<typeof submissionResultSchema>;

export const runPageSchema = pageSchema(runViewSchema);
export type RunPage = z.infer<typeof runPageSchema>;

export const steerRunBodySchema = strictObjectSchema({
  commandId: commandIdSchema,
  expectedPlanGeneration: planGenerationSchema,
  targetConfigRevision: configRevisionSchema,
  expectedPolicyRevision: policyRevisionSchema,
  input: newInputItemSchema,
  stalePolicy: steerStalePolicySchema.default('enqueue'),
});
export type SteerRunBody = z.infer<typeof steerRunBodySchema>;

export const stopRunBodySchema = strictObjectSchema({
  commandId: commandIdSchema,
  pauseQueue: z.boolean().default(true),
});
export type StopRunBody = z.infer<typeof stopRunBodySchema>;

export const approvalDecisionPathSchema = strictObjectSchema({
  threadId: threadIdSchema,
  runId: runIdSchema,
  approvalId: approvalIdSchema,
});
export type ApprovalDecisionPath = z.infer<typeof approvalDecisionPathSchema>;

export const approvalDecisionBodySchema = strictObjectSchema({
  commandId: commandIdSchema,
  expectedPlanGeneration: planGenerationSchema,
  expectedApprovalRevision: revisionSchema,
  decision: approvalDecisionSchema,
  reason: z.string().optional(),
});
export type ApprovalDecisionBody = z.infer<typeof approvalDecisionBodySchema>;

export const configChangeBodySchema = strictObjectSchema({
  commandId: commandIdSchema,
  expectedConfigRevision: configRevisionSchema,
  patch: configPatchSchema,
});
export type ConfigChangeBody = z.infer<typeof configChangeBodySchema>;

export const policyChangeBodySchema = strictObjectSchema({
  commandId: commandIdSchema,
  expectedPolicyRevision: policyRevisionSchema,
  patch: policyPatchSchema,
});
export type PolicyChangeBody = z.infer<typeof policyChangeBodySchema>;

export const operationListQuerySchema = strictObjectSchema({
  status: operationStatusSchema.optional(),
  kind: operationKindSchema.optional(),
  cursor: pageCursorSchema.optional(),
  limit: z.number().int().min(1).max(100).optional(),
});
export type OperationListQuery = z.infer<typeof operationListQuerySchema>;

export const operationPathSchema = strictObjectSchema({
  threadId: threadIdSchema,
  operationId: operationIdSchema,
});
export type OperationPath = z.infer<typeof operationPathSchema>;

export const operationPageSchema = pageSchema(operationViewSchema);
export type OperationPage = z.infer<typeof operationPageSchema>;

export const checkpointPathSchema = strictObjectSchema({
  threadId: threadIdSchema,
  checkpointId: checkpointIdSchema,
});
export type CheckpointPath = z.infer<typeof checkpointPathSchema>;

export const checkpointSummarySchema = strictObjectSchema({
  checkpointId: checkpointIdSchema,
  threadId: threadIdSchema,
  createdAt: timestampSchema,
  revision: revisionSchema,
});
export type CheckpointSummary = z.infer<typeof checkpointSummarySchema>;

export const checkpointPageSchema = pageSchema(checkpointSummarySchema);
export type CheckpointPage = z.infer<typeof checkpointPageSchema>;

export const applyCheckpointBodySchema = strictObjectSchema({
  commandId: commandIdSchema,
  expectedThreadRevision: revisionSchema,
  expectedCheckpointRevision: revisionSchema,
});
export type ApplyCheckpointBody = z.infer<typeof applyCheckpointBodySchema>;

export const eventAttachQuerySchema = strictObjectSchema({
  durableAfter: durableCursorSchema.optional(),
  incarnationId: incarnationIdSchema.optional(),
  streamAfter: streamCursorSchema.optional(),
}).refine(
  ({ incarnationId, streamAfter }) =>
    (incarnationId === undefined) === (streamAfter === undefined),
  { message: 'incarnationId and streamAfter must be provided together' },
);
export type EventAttachQuery = z.infer<typeof eventAttachQuerySchema>;

export const queueMutationBodySchema = strictObjectSchema({
  commandId: commandIdSchema,
  expectedQueueRevision: revisionSchema,
});
export type QueueMutationBody = z.infer<typeof queueMutationBodySchema>;

export const patchQueueItemBodySchema = strictObjectSchema({
  commandId: commandIdSchema,
  expectedQueueRevision: revisionSchema,
  expectedItemRevision: revisionSchema,
  input: newInputItemSchema,
});
export type PatchQueueItemBody = z.infer<typeof patchQueueItemBodySchema>;

export const reorderQueueBodySchema = strictObjectSchema({
  commandId: commandIdSchema,
  expectedQueueRevision: revisionSchema,
  queueItemId: queueItemIdSchema,
  beforeItemId: queueItemIdSchema.optional(),
  afterItemId: queueItemIdSchema.optional(),
}).refine(
  ({ beforeItemId, afterItemId }) =>
    (beforeItemId === undefined) !== (afterItemId === undefined),
  { message: 'exactly one queue reorder anchor is required' },
);
export type ReorderQueueBody = z.infer<typeof reorderQueueBodySchema>;

export const queueRevisionResultSchema = strictObjectSchema({
  queueRevision: revisionSchema,
});
export type QueueRevisionResult = z.infer<typeof queueRevisionResultSchema>;

export const patchQueueItemResultSchema = strictObjectSchema({
  queueRevision: revisionSchema,
  item: queueItemViewSchema,
});
export type PatchQueueItemResult = z.infer<typeof patchQueueItemResultSchema>;

export const undefinedResultSchema = z.undefined();

type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';
type MutationHttpMethod = Exclude<HttpMethod, 'GET'>;

interface HttpContractDescriptorBase {
  readonly path: string;
  readonly operationId: string;
  readonly pathSchema?: z.ZodType;
  readonly querySchema?: z.ZodType;
  readonly resultSchema: z.ZodType;
}

export type HttpContractDescriptor =
  | (HttpContractDescriptorBase & {
      readonly method: 'GET';
      readonly bodySchema?: never;
      readonly responseKind: 'query';
    })
  | (HttpContractDescriptorBase & {
      readonly method: MutationHttpMethod;
      readonly bodySchema: z.ZodType;
      readonly responseKind: 'commandAck';
    });

type ExactDescriptor<Descriptor extends HttpContractDescriptor> = Descriptor &
  Record<Exclude<keyof Descriptor, keyof HttpContractDescriptor>, never>;

const endpoint = <const Descriptor extends HttpContractDescriptor>(
  descriptor: ExactDescriptor<Descriptor>,
): Descriptor => descriptor;

type RegistryWithMatchingOperationIds<
  Registry extends Readonly<Record<string, HttpContractDescriptor>>,
> = {
  readonly [OperationId in keyof Registry]: Registry[OperationId] & {
    readonly operationId: OperationId;
  };
};

const defineRegistry = <
  const Registry extends Readonly<Record<string, HttpContractDescriptor>>,
>(
  registry: RegistryWithMatchingOperationIds<Registry>,
): Readonly<Registry> => {
  for (const descriptor of Object.values(registry)) {
    Object.freeze(descriptor);
  }
  return Object.freeze(registry) as Readonly<Registry>;
};

export const httpContractRegistry = defineRegistry({
  'thread.create': endpoint({
    method: 'POST',
    path: '/v2/threads',
    operationId: 'thread.create',
    bodySchema: createThreadBodySchema,
    resultSchema: threadViewSchema,
    responseKind: 'commandAck',
  }),
  'thread.list': endpoint({
    method: 'GET',
    path: '/v2/threads',
    operationId: 'thread.list',
    querySchema: paginationQuerySchema,
    resultSchema: threadPageSchema,
    responseKind: 'query',
  }),
  'thread.get': endpoint({
    method: 'GET',
    path: '/v2/threads/{threadId}',
    operationId: 'thread.get',
    pathSchema: threadPathSchema,
    querySchema: emptyQuerySchema,
    resultSchema: threadViewSchema,
    responseKind: 'query',
  }),
  'thread.patch': endpoint({
    method: 'PATCH',
    path: '/v2/threads/{threadId}',
    operationId: 'thread.patch',
    pathSchema: threadPathSchema,
    bodySchema: patchThreadBodySchema,
    resultSchema: threadViewSchema,
    responseKind: 'commandAck',
  }),
  'thread.delete': endpoint({
    method: 'DELETE',
    path: '/v2/threads/{threadId}',
    operationId: 'thread.delete',
    pathSchema: threadPathSchema,
    bodySchema: threadLifecycleBodySchema,
    resultSchema: threadViewSchema,
    responseKind: 'commandAck',
  }),
  'thread.resume': endpoint({
    method: 'POST',
    path: '/v2/threads/{threadId}/resume',
    operationId: 'thread.resume',
    pathSchema: threadPathSchema,
    bodySchema: threadLifecycleBodySchema,
    resultSchema: undefinedResultSchema,
    responseKind: 'commandAck',
  }),
  'thread.archive': endpoint({
    method: 'POST',
    path: '/v2/threads/{threadId}/archive',
    operationId: 'thread.archive',
    pathSchema: threadPathSchema,
    bodySchema: threadLifecycleBodySchema,
    resultSchema: threadViewSchema,
    responseKind: 'commandAck',
  }),
  'thread.unarchive': endpoint({
    method: 'POST',
    path: '/v2/threads/{threadId}/unarchive',
    operationId: 'thread.unarchive',
    pathSchema: threadPathSchema,
    bodySchema: threadLifecycleBodySchema,
    resultSchema: threadViewSchema,
    responseKind: 'commandAck',
  }),
  'thread.undelete': endpoint({
    method: 'POST',
    path: '/v2/threads/{threadId}/undelete',
    operationId: 'thread.undelete',
    pathSchema: threadPathSchema,
    bodySchema: threadLifecycleBodySchema,
    resultSchema: undefinedResultSchema,
    responseKind: 'commandAck',
  }),
  'thread.fork': endpoint({
    method: 'POST',
    path: '/v2/threads/{threadId}/fork',
    operationId: 'thread.fork',
    pathSchema: threadPathSchema,
    bodySchema: forkThreadBodySchema,
    resultSchema: threadViewSchema,
    responseKind: 'commandAck',
  }),
  'submission.create': endpoint({
    method: 'POST',
    path: '/v2/threads/{threadId}/submissions',
    operationId: 'submission.create',
    pathSchema: threadPathSchema,
    bodySchema: createSubmissionBodySchema,
    resultSchema: submissionResultSchema,
    responseKind: 'commandAck',
  }),
  'run.list': endpoint({
    method: 'GET',
    path: '/v2/threads/{threadId}/runs',
    operationId: 'run.list',
    pathSchema: threadPathSchema,
    querySchema: paginationQuerySchema,
    resultSchema: runPageSchema,
    responseKind: 'query',
  }),
  'run.get': endpoint({
    method: 'GET',
    path: '/v2/threads/{threadId}/runs/{runId}',
    operationId: 'run.get',
    pathSchema: runPathSchema,
    querySchema: emptyQuerySchema,
    resultSchema: runViewSchema,
    responseKind: 'query',
  }),
  'run.steer': endpoint({
    method: 'POST',
    path: '/v2/threads/{threadId}/runs/{runId}/steer',
    operationId: 'run.steer',
    pathSchema: runPathSchema,
    bodySchema: steerRunBodySchema,
    resultSchema: undefinedResultSchema,
    responseKind: 'commandAck',
  }),
  'run.stop': endpoint({
    method: 'POST',
    path: '/v2/threads/{threadId}/runs/{runId}/stop',
    operationId: 'run.stop',
    pathSchema: runPathSchema,
    bodySchema: stopRunBodySchema,
    resultSchema: undefinedResultSchema,
    responseKind: 'commandAck',
  }),
  'queue.get': endpoint({
    method: 'GET',
    path: '/v2/threads/{threadId}/queue',
    operationId: 'queue.get',
    pathSchema: threadPathSchema,
    querySchema: emptyQuerySchema,
    resultSchema: queueViewSchema,
    responseKind: 'query',
  }),
  'queue.item.patch': endpoint({
    method: 'PATCH',
    path: '/v2/threads/{threadId}/queue/items/{queueItemId}',
    operationId: 'queue.item.patch',
    pathSchema: queueItemPathSchema,
    bodySchema: patchQueueItemBodySchema,
    resultSchema: patchQueueItemResultSchema,
    responseKind: 'commandAck',
  }),
  'queue.item.delete': endpoint({
    method: 'DELETE',
    path: '/v2/threads/{threadId}/queue/items/{queueItemId}',
    operationId: 'queue.item.delete',
    pathSchema: queueItemPathSchema,
    bodySchema: queueMutationBodySchema,
    resultSchema: queueRevisionResultSchema,
    responseKind: 'commandAck',
  }),
  'queue.reorder': endpoint({
    method: 'POST',
    path: '/v2/threads/{threadId}/queue/reorder',
    operationId: 'queue.reorder',
    pathSchema: threadPathSchema,
    bodySchema: reorderQueueBodySchema,
    resultSchema: queueRevisionResultSchema,
    responseKind: 'commandAck',
  }),
  'queue.pause': endpoint({
    method: 'POST',
    path: '/v2/threads/{threadId}/queue/pause',
    operationId: 'queue.pause',
    pathSchema: threadPathSchema,
    bodySchema: queueMutationBodySchema,
    resultSchema: queueRevisionResultSchema,
    responseKind: 'commandAck',
  }),
  'queue.resume': endpoint({
    method: 'POST',
    path: '/v2/threads/{threadId}/queue/resume',
    operationId: 'queue.resume',
    pathSchema: threadPathSchema,
    bodySchema: queueMutationBodySchema,
    resultSchema: queueRevisionResultSchema,
    responseKind: 'commandAck',
  }),
  'approval.decide': endpoint({
    method: 'POST',
    path: '/v2/threads/{threadId}/runs/{runId}/approvals/{approvalId}/decision',
    operationId: 'approval.decide',
    pathSchema: approvalDecisionPathSchema,
    bodySchema: approvalDecisionBodySchema,
    resultSchema: approvalViewSchema,
    responseKind: 'commandAck',
  }),
  'config.change': endpoint({
    method: 'POST',
    path: '/v2/threads/{threadId}/config/changes',
    operationId: 'config.change',
    pathSchema: threadPathSchema,
    bodySchema: configChangeBodySchema,
    resultSchema: configRevisionResultSchema,
    responseKind: 'commandAck',
  }),
  'policy.change': endpoint({
    method: 'POST',
    path: '/v2/threads/{threadId}/policy/changes',
    operationId: 'policy.change',
    pathSchema: threadPathSchema,
    bodySchema: policyChangeBodySchema,
    resultSchema: policyRevisionResultSchema,
    responseKind: 'commandAck',
  }),
  'operation.list': endpoint({
    method: 'GET',
    path: '/v2/threads/{threadId}/operations',
    operationId: 'operation.list',
    pathSchema: threadPathSchema,
    querySchema: operationListQuerySchema,
    resultSchema: operationPageSchema,
    responseKind: 'query',
  }),
  'operation.get': endpoint({
    method: 'GET',
    path: '/v2/threads/{threadId}/operations/{operationId}',
    operationId: 'operation.get',
    pathSchema: operationPathSchema,
    querySchema: emptyQuerySchema,
    resultSchema: operationViewSchema,
    responseKind: 'query',
  }),
  'checkpoint.list': endpoint({
    method: 'GET',
    path: '/v2/threads/{threadId}/checkpoints',
    operationId: 'checkpoint.list',
    pathSchema: threadPathSchema,
    querySchema: paginationQuerySchema,
    resultSchema: checkpointPageSchema,
    responseKind: 'query',
  }),
  'checkpoint.apply': endpoint({
    method: 'POST',
    path: '/v2/threads/{threadId}/checkpoints/{checkpointId}/apply',
    operationId: 'checkpoint.apply',
    pathSchema: checkpointPathSchema,
    bodySchema: applyCheckpointBodySchema,
    resultSchema: undefinedResultSchema,
    responseKind: 'commandAck',
  }),
  'snapshot.get': endpoint({
    method: 'GET',
    path: '/v2/threads/{threadId}/snapshot',
    operationId: 'snapshot.get',
    pathSchema: threadPathSchema,
    querySchema: emptyQuerySchema,
    resultSchema: threadSnapshotSchema,
    responseKind: 'query',
  }),
  'event.attach': endpoint({
    method: 'GET',
    path: '/v2/threads/{threadId}/events',
    operationId: 'event.attach',
    pathSchema: threadPathSchema,
    querySchema: eventAttachQuerySchema,
    resultSchema: undefinedResultSchema,
    responseKind: 'query',
  }),
});

export type HttpContractRegistry = typeof httpContractRegistry;
