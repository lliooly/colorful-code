import { z } from 'zod';

export const strictObjectSchema = <Shape extends z.ZodRawShape>(shape: Shape) =>
  z.strictObject(shape);

export const healthResponseSchema = strictObjectSchema({
  status: z.literal('ok'),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;

export const timestampSchema = z.iso.datetime({ offset: true });
export type Timestamp = z.infer<typeof timestampSchema>;

const canonicalUnsignedDecimalSchema = z.string().regex(/^(0|[1-9]\d*)$/);

export const durableCursorSchema = canonicalUnsignedDecimalSchema;
export type DurableCursor = z.infer<typeof durableCursorSchema>;

export const streamCursorSchema = canonicalUnsignedDecimalSchema;
export type StreamCursor = z.infer<typeof streamCursorSchema>;

export const pageCursorSchema = canonicalUnsignedDecimalSchema;
export type PageCursor = z.infer<typeof pageCursorSchema>;

export const revisionSchema = z.number().int().nonnegative().safe();
export type Revision = z.infer<typeof revisionSchema>;

export const configRevisionSchema = z.number().int().nonnegative().safe();
export type ConfigRevision = z.infer<typeof configRevisionSchema>;

export const policyRevisionSchema = z.number().int().nonnegative().safe();
export type PolicyRevision = z.infer<typeof policyRevisionSchema>;

export const planGenerationSchema = z.number().int().nonnegative().safe();
export type PlanGeneration = z.infer<typeof planGenerationSchema>;

export const jsonValueSchema = z.json();
export type JsonValue = z.infer<typeof jsonValueSchema>;

export const pageInfoSchema = strictObjectSchema({
  nextCursor: pageCursorSchema.nullable(),
  hasMore: z.boolean(),
});
export type PageInfo = z.infer<typeof pageInfoSchema>;

export const pageSchema = <ItemSchema extends z.ZodType>(item: ItemSchema) =>
  strictObjectSchema({
    items: z.array(item),
    pageInfo: pageInfoSchema,
  });

export type Page<ItemSchema extends z.ZodType> = z.infer<
  ReturnType<typeof pageSchema<ItemSchema>>
>;
