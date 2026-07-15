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
import { runKindSchema, runStatusSchema } from './enums.js';
import {
  inputItemIdSchema,
  queueItemIdSchema,
  runIdSchema,
  threadIdSchema,
} from './ids.js';

export const runTerminalReasonSchema = strictObjectSchema({
  code: z.string().trim().min(1),
  message: z.string().optional(),
  details: jsonValueSchema.optional(),
});
export type RunTerminalReason = z.infer<typeof runTerminalReasonSchema>;

export const runViewSchema = strictObjectSchema({
  runId: runIdSchema,
  threadId: threadIdSchema,
  kind: runKindSchema,
  status: runStatusSchema,
  sourceInputItemId: inputItemIdSchema,
  sourceQueueItemId: queueItemIdSchema.nullable(),
  planGeneration: planGenerationSchema,
  configRevision: configRevisionSchema,
  policyRevision: policyRevisionSchema,
  terminalReason: runTerminalReasonSchema.nullable(),
  startedAt: timestampSchema.nullable(),
  endedAt: timestampSchema.nullable(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  revision: revisionSchema,
});
export type RunView = z.infer<typeof runViewSchema>;
