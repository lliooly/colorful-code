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

export const revisionSchema = z.number().int().safe().nonnegative();
export type Revision = z.infer<typeof revisionSchema>;

export const configRevisionSchema = z.number().int().safe().nonnegative();
export type ConfigRevision = z.infer<typeof configRevisionSchema>;

export const policyRevisionSchema = z.number().int().safe().nonnegative();
export type PolicyRevision = z.infer<typeof policyRevisionSchema>;

export const planGenerationSchema = z.number().int().safe().nonnegative();
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
type JsonToken =
  | ['value', string | number | boolean | null]
  | ['array', number]
  | ['object', number]
  | ['key', string];

type PendingJsonItem =
  | { kind: 'value'; value: unknown }
  | { kind: 'key'; key: string }
  | { kind: 'exit'; value: object };

const encodeJsonValue = (
  root: unknown,
): JsonToken[] | typeof invalidJsonValue => {
  const tokens: JsonToken[] = [];
  const ancestors = new WeakSet<object>();
  const pending: PendingJsonItem[] = [{ kind: 'value', value: root }];

  try {
    while (pending.length > 0) {
      const item = pending.pop();
      if (item === undefined) return invalidJsonValue;

      if (item.kind === 'key') {
        tokens.push(['key', item.key]);
        continue;
      }
      if (item.kind === 'exit') {
        ancestors.delete(item.value);
        continue;
      }

      const value = item.value;
      if (
        value === null ||
        typeof value === 'string' ||
        typeof value === 'boolean'
      ) {
        tokens.push(['value', value]);
        continue;
      }
      if (typeof value === 'number') {
        if (!Number.isFinite(value)) return invalidJsonValue;
        tokens.push(['value', value]);
        continue;
      }
      if (typeof value !== 'object') return invalidJsonValue;

      const isArray = Array.isArray(value);
      const prototype = Object.getPrototypeOf(value);
      if (
        (isArray && prototype !== Array.prototype) ||
        (!isArray && prototype !== Object.prototype && prototype !== null) ||
        ancestors.has(value)
      ) {
        return invalidJsonValue;
      }

      const descriptors = Object.getOwnPropertyDescriptors(value);
      const keys = Reflect.ownKeys(descriptors);
      ancestors.add(value);
      pending.push({ kind: 'exit', value });

      if (isArray) {
        const lengthDescriptor = descriptors.length;
        if (!hasDataValue(lengthDescriptor)) return invalidJsonValue;
        const length = lengthDescriptor.value;
        if (
          !Number.isSafeInteger(length) ||
          length < 0 ||
          keys.length !== length + 1
        ) {
          return invalidJsonValue;
        }

        tokens.push(['array', length]);
        for (let index = length - 1; index >= 0; index -= 1) {
          const descriptor = descriptors[String(index)];
          if (!hasDataValue(descriptor) || !descriptor.enumerable) {
            return invalidJsonValue;
          }
          pending.push({ kind: 'value', value: descriptor.value });
        }
        continue;
      }

      const stringKeys: string[] = [];
      for (const key of keys) {
        if (typeof key !== 'string') return invalidJsonValue;
        const descriptor = descriptors[key];
        if (!hasDataValue(descriptor) || !descriptor.enumerable) {
          return invalidJsonValue;
        }
        stringKeys.push(key);
      }

      tokens.push(['object', stringKeys.length]);
      for (let index = stringKeys.length - 1; index >= 0; index -= 1) {
        const key = stringKeys[index];
        if (key === undefined) return invalidJsonValue;
        const descriptor = descriptors[key];
        if (!hasDataValue(descriptor)) return invalidJsonValue;
        pending.push({ kind: 'value', value: descriptor.value });
        pending.push({ kind: 'key', key });
      }
    }
  } catch {
    return invalidJsonValue;
  }

  return tokens;
};

type JsonContainerFrame =
  | { kind: 'array'; value: JsonValue[]; remaining: number }
  | {
      kind: 'object';
      value: JsonObject;
      remaining: number;
      key?: string;
    };

const decodeJsonValue = (encoded: JsonValue): JsonValue => {
  const tokens = encoded as JsonToken[];
  const containers: JsonContainerFrame[] = [];
  let root: JsonValue | undefined;
  let hasRoot = false;

  const attach = (value: JsonValue) => {
    const parent = containers.at(-1);
    if (parent === undefined) {
      root = value;
      hasRoot = true;
      return;
    }
    if (parent.kind === 'array') {
      parent.value.push(value);
    } else {
      const key = parent.key;
      if (key === undefined) throw new Error('Invalid encoded JSON object');
      Object.defineProperty(parent.value, key, {
        value,
        enumerable: true,
        writable: true,
        configurable: true,
      });
      delete parent.key;
    }
    parent.remaining -= 1;
  };

  const removeCompletedContainers = () => {
    while (containers.at(-1)?.remaining === 0) containers.pop();
  };

  for (const token of tokens) {
    const [kind, payload] = token;
    if (kind === 'key') {
      const parent = containers.at(-1);
      if (parent?.kind !== 'object' || parent.key !== undefined) {
        throw new Error('Invalid encoded JSON key');
      }
      parent.key = payload;
      continue;
    }
    if (kind === 'value') {
      attach(payload);
      removeCompletedContainers();
      continue;
    }

    const value: JsonValue =
      kind === 'array' ? [] : (Object.create(null) as JsonObject);
    attach(value);
    if (payload > 0) {
      if (kind === 'array') {
        containers.push({
          kind,
          value: value as JsonValue[],
          remaining: payload,
        });
      } else {
        containers.push({
          kind,
          value: value as JsonObject,
          remaining: payload,
        });
      }
    } else {
      removeCompletedContainers();
    }
  }

  if (!hasRoot || containers.length > 0) {
    throw new Error('Invalid encoded JSON value');
  }
  return root as JsonValue;
};

const jsonValueNormalizerSchema = z
  .unknown()
  .transform<JsonValue>((value, context) => {
    const encoded = encodeJsonValue(value);
    if (encoded === invalidJsonValue) {
      context.addIssue({ code: 'custom', message: 'Expected a JSON value' });
      return z.NEVER;
    }
    return encoded as JsonValue;
  });

export const jsonValueSchema = jsonValueNormalizerSchema
  .pipe(z.json())
  .overwrite(decodeJsonValue);

const jsonObjectOutputSchema = z.record(z.string(), z.json());

const jsonObjectNormalizerSchema = z.unknown().transform((value, context) => {
  const encoded = encodeJsonValue(value);
  if (encoded === invalidJsonValue || encoded[0]?.[0] !== 'object') {
    context.addIssue({ code: 'custom', message: 'Expected a JSON object' });
    return z.NEVER;
  }
  const wrapper = Object.create(null) as JsonObject;
  Object.defineProperty(wrapper, '\u0000', {
    value: encoded,
    enumerable: true,
    writable: true,
    configurable: true,
  });
  return wrapper;
});

export const jsonObjectSchema = jsonObjectNormalizerSchema
  .pipe(jsonObjectOutputSchema)
  .overwrite((value) => decodeJsonValue(value['\u0000']) as JsonObject);

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
