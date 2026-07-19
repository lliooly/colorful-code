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

const UNIQUE_ITEMS_METADATA = Object.freeze({ uniqueItems: true });
const PLUGIN_CAPABILITY_UNIQUE_BY = Object.freeze([
  'pluginId',
  'capability',
] as const);
const PLUGIN_CAPABILITIES_METADATA = Object.freeze({
  uniqueItems: true,
  'x-colorful-uniqueBy': PLUGIN_CAPABILITY_UNIQUE_BY,
});
const POLICY_PATCH_METADATA = Object.freeze({ minProperties: 1 });

const canonicalHostnamePattern =
  /^(?!(?:(?:\d+|0x[0-9a-f]+)\.)*(?:\d+|0x[0-9a-f]+)$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
const canonicalIdentityPattern = /^\S(?:[\s\S]*\S)?$/;
const canonicalIdentityInputSchema = z
  .string()
  .regex(canonicalIdentityPattern, {
    message: 'must not have leading or trailing whitespace',
  });

const allowedHostSchema = z
  .string()
  .min(1)
  .max(253)
  .regex(canonicalHostnamePattern, {
    message: 'must be a canonical lowercase hostname',
  });

const hasUniqueStrings = (values: readonly string[]) =>
  new Set(values).size === values.length;

const allowedHostsSchema = z
  .array(allowedHostSchema)
  .refine(hasUniqueStrings, { message: 'allowedHosts must be unique' });

export const networkPolicySchema = z.discriminatedUnion('mode', [
  strictObjectSchema({
    mode: z.literal('denyAll'),
  }),
  strictObjectSchema({
    mode: z.literal('allowListed'),
    allowedHosts: allowedHostsSchema.optional(),
  }),
]);
export type NetworkPolicy = z.infer<typeof networkPolicySchema>;

const pluginCapabilitySchema = canonicalIdentityInputSchema.pipe(
  z.string().trim().min(1).regex(canonicalIdentityPattern),
);
export const pluginCapabilitiesSchema = strictObjectSchema({
  pluginId: canonicalIdentityInputSchema.pipe(
    pluginIdSchema.regex(canonicalIdentityPattern),
  ),
  capability: pluginCapabilitySchema,
  decision: z.enum(['allow', 'deny']),
});
export type PluginCapabilities = z.infer<typeof pluginCapabilitiesSchema>;

const canonicalCredentialRefIdSchema = canonicalIdentityInputSchema.pipe(
  credentialRefIdSchema.regex(canonicalIdentityPattern),
);
const credentialRefsSchema = z
  .array(canonicalCredentialRefIdSchema)
  .refine(hasUniqueStrings, {
    message: 'credential references must be unique',
  });

const hasUniquePluginCapabilities = (
  declarations: readonly PluginCapabilities[],
) => {
  const capabilitiesByPlugin = new Map<string, Set<string>>();

  for (const declaration of declarations) {
    const capabilities =
      capabilitiesByPlugin.get(declaration.pluginId) ?? new Set<string>();
    if (capabilities.has(declaration.capability)) return false;
    capabilities.add(declaration.capability);
    capabilitiesByPlugin.set(declaration.pluginId, capabilities);
  }

  return true;
};

const pluginCapabilityDeclarationsSchema = z
  .array(pluginCapabilitiesSchema)
  .refine(hasUniquePluginCapabilities, {
    message: 'plugin capability declarations must be unique',
  });

export const policyPatchSchema = strictObjectSchema({
  workspaceTrust: workspaceTrustSchema.optional(),
  sandbox: sandboxPolicySchema.optional(),
  network: networkPolicySchema.optional(),
  pluginCapabilities: pluginCapabilityDeclarationsSchema.optional(),
  credentialRefs: credentialRefsSchema.optional(),
  revokeCredentialRefs: credentialRefsSchema.optional(),
}).refine(
  (patch) => Object.values(patch).some((value) => value !== undefined),
  {
    message: 'at least one policy field is required',
  },
);
export type PolicyPatch = z.infer<typeof policyPatchSchema>;

const POLICY_METADATA_DESCRIPTORS = Object.freeze([
  Object.freeze([allowedHostsSchema, UNIQUE_ITEMS_METADATA] as const),
  Object.freeze([credentialRefsSchema, UNIQUE_ITEMS_METADATA] as const),
  Object.freeze([
    pluginCapabilityDeclarationsSchema,
    PLUGIN_CAPABILITIES_METADATA,
  ] as const),
  Object.freeze([policyPatchSchema, POLICY_PATCH_METADATA] as const),
] as const);

export const registerPolicyContractMetadata = (
  metadata: z.core.$ZodRegistry<Record<string, unknown>>,
) => {
  for (const [describedSchema, descriptor] of POLICY_METADATA_DESCRIPTORS) {
    metadata.add(describedSchema, descriptor);
  }
};

export const policyRevisionResultSchema = strictObjectSchema({
  policyRevision: policyRevisionSchema,
});
export type PolicyRevisionResult = z.infer<typeof policyRevisionResultSchema>;
