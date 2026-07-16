import { z } from 'zod';

import {
  configRevisionSchema,
  jsonValueSchema,
  planGenerationSchema,
  policyRevisionSchema,
  revisionSchema,
  strictObjectSchema,
  timestampSchema,
} from './common.js';
import {
  approvalDecisionSchema,
  approvalKindSchema,
  approvalStatusSchema,
  operationKindSchema,
  operationStatusSchema,
  toolExecutionStateSchema,
} from './enums.js';
import {
  approvalIdSchema,
  artifactIdSchema,
  operationIdSchema,
  runIdSchema,
  threadIdSchema,
  toolExecutionIdSchema,
} from './ids.js';
import { apiErrorPayloadSchema } from './errors.js';

const operationTerminalCommonShape = () => ({
  operationId: operationIdSchema,
  kind: operationKindSchema,
  runId: runIdSchema.nullable(),
  revision: revisionSchema,
});

export const operationTerminalEventPayloadSchema = z.discriminatedUnion(
  'status',
  [
    strictObjectSchema({
      ...operationTerminalCommonShape(),
      status: z.literal('completed'),
      completedAt: timestampSchema,
      result: jsonValueSchema.optional(),
    }),
    strictObjectSchema({
      ...operationTerminalCommonShape(),
      status: z.literal('failed'),
      error: apiErrorPayloadSchema,
    }),
    strictObjectSchema({
      ...operationTerminalCommonShape(),
      status: z.literal('cancelled'),
      reason: z.string().trim().min(1),
      cancelledAt: timestampSchema,
      result: jsonValueSchema.optional(),
    }),
  ],
);
export type OperationTerminalEventPayload = z.infer<
  typeof operationTerminalEventPayloadSchema
>;

export const operationProgressSchema = strictObjectSchema({
  phase: z.string().trim().min(1),
  completedUnits: z.number().int().safe().nonnegative().optional(),
  totalUnits: z.number().int().safe().nonnegative().optional(),
  message: z.string().optional(),
});
export type OperationProgress = z.infer<typeof operationProgressSchema>;

export const operationViewSchema = strictObjectSchema({
  operationId: operationIdSchema,
  threadId: threadIdSchema,
  kind: operationKindSchema,
  status: operationStatusSchema,
  phase: z.string().trim().min(1),
  parentOperationId: operationIdSchema.nullable(),
  runId: runIdSchema.nullable(),
  expectedPlanGeneration: planGenerationSchema.nullable(),
  appliedPlanGeneration: planGenerationSchema.nullable(),
  targetConfigRevision: configRevisionSchema.nullable(),
  appliedConfigRevision: configRevisionSchema.nullable(),
  targetPolicyRevision: policyRevisionSchema.nullable(),
  appliedPolicyRevision: policyRevisionSchema.nullable(),
  progress: operationProgressSchema.nullable(),
  result: jsonValueSchema.nullable(),
  error: jsonValueSchema.nullable(),
  revision: revisionSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  completedAt: timestampSchema.nullable(),
});
export type OperationView = z.infer<typeof operationViewSchema>;

export const approvalDecisionViewSchema = strictObjectSchema({
  decision: approvalDecisionSchema,
  reason: z.string().optional(),
});
export const approvalViewSchema = strictObjectSchema({
  approvalId: approvalIdSchema,
  threadId: threadIdSchema,
  runId: runIdSchema,
  kind: approvalKindSchema,
  status: approvalStatusSchema,
  planGeneration: planGenerationSchema,
  policyRevision: policyRevisionSchema,
  requestSummary: jsonValueSchema,
  decision: approvalDecisionViewSchema.nullable(),
  revision: revisionSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  decidedAt: timestampSchema.nullable(),
  expiresAt: timestampSchema.nullable(),
});
export type ApprovalView = z.infer<typeof approvalViewSchema>;

export const artifactReferenceSchema = strictObjectSchema({
  artifactId: artifactIdSchema,
  mediaType: z.string().trim().min(1),
  byteLength: z.number().int().safe().nonnegative(),
  label: z.string().nullable(),
});
export type ArtifactReference = z.infer<typeof artifactReferenceSchema>;

export const toolExecutionSummarySchema = strictObjectSchema({
  toolExecutionId: toolExecutionIdSchema,
  threadId: threadIdSchema,
  runId: runIdSchema,
  toolName: z.string().trim().min(1),
  state: toolExecutionStateSchema,
  planGeneration: planGenerationSchema,
  policyRevision: policyRevisionSchema,
  redactedSummary: jsonValueSchema,
  artifacts: z.array(artifactReferenceSchema),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  completedAt: timestampSchema.nullable(),
});
export type ToolExecutionSummary = z.infer<typeof toolExecutionSummarySchema>;
