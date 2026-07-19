import { z } from 'zod';

import { tokenRefSchema } from './auth.js';
import { undefinedResultSchema } from './commands.js';
import { registerConfigContractMetadata } from './config.js';
import { durableBasisSchema, streamBasisSchema } from './events.js';
import { registerPolicyContractMetadata } from './policy.js';

export * from './ack.js';
export * from './auth.js';
export * from './commands.js';
export * from './common.js';
export * from './config.js';
export * from './enums.js';
export * from './errors.js';
export * from './events.js';
export * from './ids.js';
export * from './operations.js';
export * from './policy.js';
export * from './queue.js';
export * from './run.js';
export * from './snapshot.js';
export * from './thread.js';

const TOKEN_REF_METADATA = Object.freeze({
  description:
    'OS credential-store reference for the daemon authentication token; never the token value',
});
const STREAM_BASIS_METADATA = Object.freeze({
  description:
    'streamBasis references a pre-existing high-watermark in a specific incarnation stream space. It must not be compared with durableSequence or any durable cursor; it is a causal basis, not a third cursor.',
});
const DURABLE_BASIS_METADATA = Object.freeze({
  description:
    'durableBasis references a pre-existing high-watermark in the durable cursor space. It must not be compared with streamSequence or any incarnation stream cursor; it is a causal basis, not a third cursor.',
});

const CONTRACT_METADATA_DESCRIPTORS = Object.freeze([
  Object.freeze([tokenRefSchema, TOKEN_REF_METADATA] as const),
  Object.freeze([streamBasisSchema, STREAM_BASIS_METADATA] as const),
  Object.freeze([durableBasisSchema, DURABLE_BASIS_METADATA] as const),
] as const);

export const toContractJsonSchema = <Schema extends z.ZodType>(
  schema: Schema,
) => {
  const metadata = z.registry<Record<string, unknown>>();
  for (const [describedSchema, descriptor] of CONTRACT_METADATA_DESCRIPTORS) {
    metadata.add(describedSchema, descriptor);
  }
  registerConfigContractMetadata(metadata);
  registerPolicyContractMetadata(metadata);

  if (Object.is(schema, undefinedResultSchema)) return { not: {} };
  return z.toJSONSchema(schema, { metadata });
};
