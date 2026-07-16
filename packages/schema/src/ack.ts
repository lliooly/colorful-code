import { z } from 'zod';

import {
  durableCursorSchema,
  strictObjectSchema,
  timestampSchema,
} from './common.js';
import {
  commandIdSchema,
  operationIdSchema,
  runIdSchema,
  threadIdSchema,
} from './ids.js';

const commandAckShape = () => ({
  commandId: commandIdSchema,
  operationId: operationIdSchema.optional(),
  status: z.literal('accepted'),
  replayed: z.boolean(),
  threadId: threadIdSchema,
  runId: runIdSchema.optional(),
  completionEvents: z.array(z.string()).optional(),
  currentDurableCursor: durableCursorSchema,
  acceptedAt: timestampSchema,
});

type CommandAckShape = ReturnType<typeof commandAckShape>;
type ResultShape<ResultSchema extends z.ZodType | undefined> =
  ResultSchema extends z.ZodType
    ? { result: z.ZodOptional<ResultSchema> }
    : Record<never, never>;

export type CommandAckSchema<
  ResultSchema extends z.ZodType | undefined = undefined,
> = z.ZodObject<CommandAckShape & ResultShape<ResultSchema>>;

export const commandAckSchema = <
  ResultSchema extends z.ZodType | undefined = undefined,
>(
  resultSchema?: ResultSchema,
): CommandAckSchema<ResultSchema> => {
  const shape = commandAckShape();

  return (
    resultSchema === undefined
      ? strictObjectSchema(shape)
      : strictObjectSchema({ ...shape, result: resultSchema.optional() })
  ) as CommandAckSchema<ResultSchema>;
};

export type CommandAck<ResultSchema extends z.ZodType | undefined = undefined> =
  z.infer<CommandAckSchema<ResultSchema>>;
