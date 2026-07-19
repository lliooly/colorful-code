import { z } from 'zod';

import {
  canonicalNonBlankStringSchema,
  revisionSchema,
  strictObjectSchema,
  timestampSchema,
} from './common.js';
import {
  credentialRefIdSchema,
  daemonInstanceIdSchema,
  principalIdSchema,
} from './ids.js';

export const authenticatedPrincipalKindSchema = z.enum([
  'installationClient',
  'system',
]);
export type AuthenticatedPrincipalKind = z.infer<
  typeof authenticatedPrincipalKindSchema
>;

export const authenticatedPrincipalSchema = strictObjectSchema({
  principalId: principalIdSchema,
  clientIdentity: canonicalNonBlankStringSchema,
  kind: authenticatedPrincipalKindSchema,
  authenticatedAt: timestampSchema,
  credentialVersion: revisionSchema,
  capabilities: z.array(canonicalNonBlankStringSchema),
});
export type AuthenticatedPrincipal = z.infer<
  typeof authenticatedPrincipalSchema
>;

const httpLoopbackEndpointSchema = z
  .string()
  .regex(
    /^http:\/\/127\.0\.0\.1:(?:[1-9]\d{0,3}|[1-5]\d{4}|6[0-4]\d{3}|65[0-4]\d{2}|655[0-2]\d|6553[0-5])$/,
    'loopback HTTP endpoint must use a canonical port from 1 through 65535',
  );

const unixEndpointSchema = z
  .string()
  // Endpoint patterns must export the C0/DEL exclusion to JSON Schema.
  // eslint-disable-next-line no-control-regex
  .regex(/^unix:\/[^/?#\s\x00-\x1f\x7f][^?#\s\x00-\x1f\x7f]*$/);
const namedPipeEndpointSchema = z
  .string()
  // Endpoint patterns must export the C0/DEL exclusion to JSON Schema.
  // eslint-disable-next-line no-control-regex
  .regex(/^npipe:\/{4}\.\/pipe\/[^?#\s\x00-\x1f\x7f]+$/);

export const daemonEndpointSchema = z.union([
  httpLoopbackEndpointSchema,
  unixEndpointSchema,
  namedPipeEndpointSchema,
]);
export type DaemonEndpoint = z.infer<typeof daemonEndpointSchema>;

export const tokenRefSchema = credentialRefIdSchema.clone();
export type TokenRef = z.infer<typeof tokenRefSchema>;

export const daemonDiscoverySchema = strictObjectSchema({
  endpoint: daemonEndpointSchema,
  daemonInstanceId: daemonInstanceIdSchema,
  tokenRef: tokenRefSchema,
  protocolVersion: z.literal('2'),
});
export type DaemonDiscovery = z.infer<typeof daemonDiscoverySchema>;
