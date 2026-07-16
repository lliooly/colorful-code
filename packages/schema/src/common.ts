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

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

const hasDataValue = (
  descriptor: PropertyDescriptor | undefined,
): descriptor is PropertyDescriptor & { value: unknown } =>
  descriptor !== undefined && 'value' in descriptor;

const invalidJsonValue = Symbol('invalidJsonValue');
const MAX_JSON_DEPTH = 100;

const snapshotJsonValue = (
  value: unknown,
  ancestors: WeakSet<object>,
  depth: number,
): JsonValue | typeof invalidJsonValue => {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : invalidJsonValue;
  }
  if (typeof value !== 'object') return invalidJsonValue;
  if (depth >= MAX_JSON_DEPTH) return invalidJsonValue;

  try {
    const isArray = Array.isArray(value);
    const prototype = Object.getPrototypeOf(value);
    if (
      (isArray && prototype !== Array.prototype) ||
      (!isArray && prototype !== Object.prototype && prototype !== null)
    ) {
      return invalidJsonValue;
    }
    if (ancestors.has(value)) return invalidJsonValue;

    ancestors.add(value);
    try {
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const keys = Reflect.ownKeys(descriptors);

      if (isArray) {
        const lengthDescriptor = descriptors.length;
        if (!hasDataValue(lengthDescriptor)) return invalidJsonValue;
        const length = lengthDescriptor.value;
        if (!Number.isSafeInteger(length) || length < 0) {
          return invalidJsonValue;
        }
        if (keys.length !== length + 1) return invalidJsonValue;

        const snapshot: JsonValue[] = new Array(length);
        for (const key of keys) {
          if (key === 'length') continue;
          if (typeof key !== 'string') return invalidJsonValue;
          const index = Number(key);
          if (
            !Number.isSafeInteger(index) ||
            index < 0 ||
            index >= length ||
            String(index) !== key
          ) {
            return invalidJsonValue;
          }
          const descriptor = descriptors[key];
          if (!hasDataValue(descriptor) || !descriptor.enumerable) {
            return invalidJsonValue;
          }
          const item = snapshotJsonValue(
            descriptor.value,
            ancestors,
            depth + 1,
          );
          if (item === invalidJsonValue) return invalidJsonValue;
          Object.defineProperty(snapshot, key, {
            value: item,
            enumerable: true,
            writable: true,
            configurable: true,
          });
        }
        return snapshot;
      }

      const snapshot = Object.create(null) as JsonObject;
      for (const key of keys) {
        if (typeof key !== 'string') return invalidJsonValue;
        const descriptor = descriptors[key];
        if (!hasDataValue(descriptor) || !descriptor.enumerable) {
          return invalidJsonValue;
        }
        const item = snapshotJsonValue(descriptor.value, ancestors, depth + 1);
        if (item === invalidJsonValue) return invalidJsonValue;
        Object.defineProperty(snapshot, key, {
          value: item,
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      return snapshot;
    } finally {
      ancestors.delete(value);
    }
  } catch {
    return invalidJsonValue;
  }
};

const prefixJsonKeys = (value: JsonValue): JsonValue => {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(prefixJsonKeys);

  const prefixed = Object.create(null) as JsonObject;
  for (const [key, item] of Object.entries(value)) {
    Object.defineProperty(prefixed, `\u0000${key}`, {
      value: prefixJsonKeys(item),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return prefixed;
};

const removeJsonKeyPrefixes = (value: JsonValue): JsonValue => {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(removeJsonKeyPrefixes);

  const normalized = Object.create(null) as JsonObject;
  for (const [key, item] of Object.entries(value)) {
    Object.defineProperty(normalized, key.slice(1), {
      value: removeJsonKeyPrefixes(item),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return normalized;
};

const jsonValueNormalizerSchema = z.unknown().transform((value, context) => {
  const snapshot = snapshotJsonValue(value, new WeakSet(), 0);
  if (snapshot === invalidJsonValue) {
    context.addIssue({ code: 'custom', message: 'Expected a JSON value' });
    return z.NEVER;
  }
  return prefixJsonKeys(snapshot);
});

export const jsonValueSchema = jsonValueNormalizerSchema
  .pipe(z.json())
  .overwrite(removeJsonKeyPrefixes);

const jsonObjectOutputSchema = z.record(z.string(), z.json());

const jsonObjectNormalizerSchema = z.unknown().transform((value, context) => {
  const snapshot = snapshotJsonValue(value, new WeakSet(), 0);
  if (
    snapshot === invalidJsonValue ||
    snapshot === null ||
    typeof snapshot !== 'object' ||
    Array.isArray(snapshot)
  ) {
    context.addIssue({ code: 'custom', message: 'Expected a JSON object' });
    return z.NEVER;
  }
  return prefixJsonKeys(snapshot) as JsonObject;
});

export const jsonObjectSchema = jsonObjectNormalizerSchema
  .pipe(jsonObjectOutputSchema)
  .overwrite((value) => removeJsonKeyPrefixes(value) as JsonObject);

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
