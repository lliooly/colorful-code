import { z } from 'zod';

import {
  configRevisionSchema,
  jsonValueSchema,
  policyRevisionSchema,
  revisionSchema,
  strictObjectSchema,
  timestampSchema,
} from './common.js';
import {
  inputRoleSchema,
  inputSourceSchema,
  threadRuntimeStatusSchema,
} from './enums.js';
import {
  artifactIdSchema,
  inputItemIdSchema,
  lineageIdSchema,
  runIdSchema,
  threadIdSchema,
  workspaceIdSchema,
} from './ids.js';

export const workspaceTrustSchema = z.enum(['trusted', 'untrusted']);
export type WorkspaceTrust = z.infer<typeof workspaceTrustSchema>;

export const workspaceBindingSchema = strictObjectSchema({
  workspaceId: workspaceIdSchema,
  displayPath: z.string().trim().min(1),
  trust: workspaceTrustSchema,
});
export type WorkspaceBinding = z.infer<typeof workspaceBindingSchema>;

export const textInputContentSchema = strictObjectSchema({
  kind: z.literal('text'),
  text: z.string().min(1),
});
export type TextInputContent = z.infer<typeof textInputContentSchema>;

export const structuredInputContentSchema = strictObjectSchema({
  kind: z.literal('structured'),
  value: jsonValueSchema,
});
export type StructuredInputContent = z.infer<
  typeof structuredInputContentSchema
>;

export const artifactReferencesInputContentSchema = strictObjectSchema({
  kind: z.literal('artifactReferences'),
  artifactIds: z.array(artifactIdSchema).min(1),
});
export type ArtifactReferencesInputContent = z.infer<
  typeof artifactReferencesInputContentSchema
>;

export const inputContentSchema = z.discriminatedUnion('kind', [
  textInputContentSchema,
  structuredInputContentSchema,
  artifactReferencesInputContentSchema,
]);
export type InputContent = z.infer<typeof inputContentSchema>;

export const inputItemViewSchema = strictObjectSchema({
  inputItemId: inputItemIdSchema,
  threadId: threadIdSchema,
  role: inputRoleSchema,
  source: inputSourceSchema,
  content: inputContentSchema,
  supersedesInputItemId: inputItemIdSchema.nullable(),
  createdAt: timestampSchema,
});
export type InputItemView = z.infer<typeof inputItemViewSchema>;

const threadViewBaseShape = {
  threadId: threadIdSchema,
  lineageId: lineageIdSchema,
  parentThreadId: threadIdSchema.nullable(),
  runtimeStatus: threadRuntimeStatusSchema,
  title: z.string().nullable(),
  goal: z.string().nullable(),
  workspaceBinding: workspaceBindingSchema,
  activeRunId: runIdSchema.nullable(),
  threadRevision: revisionSchema,
  queueRevision: revisionSchema,
  configRevision: configRevisionSchema,
  policyRevision: policyRevisionSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
};

export const threadViewSchema = z.discriminatedUnion('lifecycle', [
  strictObjectSchema({
    ...threadViewBaseShape,
    lifecycle: z.literal('available'),
  }),
  strictObjectSchema({
    ...threadViewBaseShape,
    lifecycle: z.literal('archived'),
  }),
  strictObjectSchema({
    ...threadViewBaseShape,
    lifecycle: z.literal('deleted'),
    deletedAt: timestampSchema.nullable().optional(),
  }),
]);
export type ThreadView = z.infer<typeof threadViewSchema>;
