import { z } from 'zod';

import {
  configRevisionSchema,
  jsonValueSchema,
  strictObjectSchema,
} from './common.js';
import { credentialRefIdSchema } from './ids.js';

const boundedConfigNameSchema = z.string().trim().min(1).max(256);

export const reasoningEffortSchema = z.enum(['low', 'medium', 'high']);
export type ReasoningEffort = z.infer<typeof reasoningEffortSchema>;

export const configPatchSchema = strictObjectSchema({
  model: boundedConfigNameSchema.optional(),
  provider: boundedConfigNameSchema.optional(),
  providerCredentialRef: credentialRefIdSchema.optional(),
  temperature: z.number().finite().min(0).max(2).optional(),
  topP: z.number().finite().min(0).max(1).optional(),
  maxOutputTokens: z.number().int().positive().safe().optional(),
  reasoningEffort: reasoningEffortSchema.optional(),
  providerOptions: z.record(z.string(), jsonValueSchema).optional(),
}).refine(
  (patch) => Object.values(patch).some((value) => value !== undefined),
  {
    message: 'at least one config field is required',
  },
);
export type ConfigPatch = z.infer<typeof configPatchSchema>;

export const configRevisionResultSchema = strictObjectSchema({
  configRevision: configRevisionSchema,
});
export type ConfigRevisionResult = z.infer<typeof configRevisionResultSchema>;
