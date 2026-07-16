import { z } from 'zod';

import { policyRevisionSchema, strictObjectSchema } from './common.js';
import { credentialRefIdSchema, pluginIdSchema } from './ids.js';
import { workspaceTrustSchema } from './thread.js';

export const sandboxPolicySchema = z.enum([
  'readOnly',
  'workspaceWrite',
  'unrestricted',
]);
export type SandboxPolicy = z.infer<typeof sandboxPolicySchema>;

const allowedHostSchema = z.string().trim().min(1).max(253);
export const networkPolicySchema = z.discriminatedUnion('mode', [
  strictObjectSchema({
    mode: z.literal('denyAll'),
  }),
  strictObjectSchema({
    mode: z.literal('allowListed'),
    allowedHosts: z.array(allowedHostSchema).min(1).max(100),
  }),
]);
export type NetworkPolicy = z.infer<typeof networkPolicySchema>;

const pluginCapabilitySchema = z.string().trim().min(1).max(128);
export const pluginCapabilitiesSchema = strictObjectSchema({
  pluginId: pluginIdSchema,
  capabilities: z.array(pluginCapabilitySchema).min(1).max(100),
});
export type PluginCapabilities = z.infer<typeof pluginCapabilitiesSchema>;

const credentialRefsSchema = z.array(credentialRefIdSchema).max(100);

export const policyPatchSchema = strictObjectSchema({
  workspaceTrust: workspaceTrustSchema.optional(),
  sandbox: sandboxPolicySchema.optional(),
  network: networkPolicySchema.optional(),
  pluginCapabilities: z.array(pluginCapabilitiesSchema).max(100).optional(),
  credentialRefs: credentialRefsSchema.optional(),
  revokeCredentialRefs: credentialRefsSchema.optional(),
}).refine(
  (patch) => Object.values(patch).some((value) => value !== undefined),
  {
    message: 'at least one policy field is required',
  },
);
export type PolicyPatch = z.infer<typeof policyPatchSchema>;

export const policyRevisionResultSchema = strictObjectSchema({
  policyRevision: policyRevisionSchema,
});
export type PolicyRevisionResult = z.infer<typeof policyRevisionResultSchema>;
