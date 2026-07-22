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
import { operationCompletionEventKindSchema } from './enums.js';

const commandAckShape = () => ({
  commandId: commandIdSchema,
  status: z.literal('accepted'),
  replayed: z.boolean(),
  threadId: threadIdSchema,
  runId: runIdSchema.optional(),
  currentDurableCursor: durableCursorSchema,
  acceptedAt: timestampSchema,
});

type CommandAckShape = ReturnType<typeof commandAckShape>;
type ResultShape<ResultSchema extends z.ZodType | undefined> =
  ResultSchema extends z.ZodType
    ? { result: z.ZodOptional<ResultSchema> }
    : Record<never, never>;
type SynchronousCommandAckShape<ResultSchema extends z.ZodType | undefined> =
  CommandAckShape & ResultShape<ResultSchema>;
type AsynchronousCommandAckShape<ResultSchema extends z.ZodType | undefined> =
  CommandAckShape & {
    operationId: typeof operationIdSchema;
    completionEvents: z.ZodArray<typeof operationCompletionEventKindSchema>;
  } & ResultShape<ResultSchema>;
type StrictObjectSchema<Shape extends z.ZodRawShape> = ReturnType<
  typeof strictObjectSchema<Shape>
>;

export type CommandAckSchema<
  ResultSchema extends z.ZodType | undefined = undefined,
> = z.ZodUnion<
  readonly [
    StrictObjectSchema<SynchronousCommandAckShape<ResultSchema>>,
    StrictObjectSchema<AsynchronousCommandAckShape<ResultSchema>>,
  ]
>;

export const commandAckSchema = <
  ResultSchema extends z.ZodType | undefined = undefined,
>(
  resultSchema?: ResultSchema,
): CommandAckSchema<ResultSchema> => {
  const synchronousShape = {
    ...commandAckShape(),
    ...(resultSchema === undefined ? {} : { result: resultSchema.optional() }),
  };
  const asynchronousShape = {
    ...commandAckShape(),
    operationId: operationIdSchema,
    completionEvents: z.array(operationCompletionEventKindSchema).min(1),
    ...(resultSchema === undefined ? {} : { result: resultSchema.optional() }),
  };

  return z.union([
    strictObjectSchema(synchronousShape),
    strictObjectSchema(asynchronousShape),
  ]) as CommandAckSchema<ResultSchema>;
};

export const commandAckWithoutResultSchema = commandAckSchema();
export type CommandAckWithoutResult = z.infer<
  typeof commandAckWithoutResultSchema
>;

export type CommandAck<ResultSchema extends z.ZodType | undefined = undefined> =
  z.infer<CommandAckSchema<ResultSchema>>;
