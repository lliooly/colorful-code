import { z } from 'zod';

export const strictObjectSchema = <Shape extends z.ZodRawShape>(shape: Shape) =>
  z.strictObject(shape);

export const healthResponseSchema = strictObjectSchema({
  status: z.literal('ok'),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;

export const timestampSchema = z.iso.datetime({ offset: true });
export type Timestamp = z.infer<typeof timestampSchema>;

export const canonicalNonBlankStringSchema = z
  .string()
  .min(1)
  .regex(/^\S(?:[\s\S]*\S)?$/, 'must not have leading or trailing whitespace');
export type CanonicalNonBlankString = z.infer<
  typeof canonicalNonBlankStringSchema
>;

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
const jsonValueExceedsMaxLength = Symbol('jsonValueExceedsMaxLength');
const jsonValueExceedsMaxTokenCount = Symbol('jsonValueExceedsMaxTokenCount');
type JsonToken =
  | ['value', string | number | boolean | null]
  | ['array', number]
  | ['object', number]
  | ['key', string];

type PendingJsonItem =
  | { kind: 'value'; value: unknown }
  | { kind: 'key'; key: string }
  | { kind: 'array'; value: unknown[]; index: number; length: number }
  | { kind: 'object'; value: object; keys: string[]; index: number };

type JsonEncodingBudget = { remaining: number };

const consumeJsonLength = (
  budget: JsonEncodingBudget | undefined,
  length: number,
) => {
  if (budget === undefined) return true;
  if (length > budget.remaining) return false;
  budget.remaining -= length;
  return true;
};

const hasArrayTokenMinimum = (
  budget: JsonEncodingBudget | undefined,
  length: number,
) =>
  budget === undefined ||
  (budget.remaining > 0 && length <= budget.remaining - 1);

const hasObjectTokenMinimum = (
  budget: JsonEncodingBudget | undefined,
  keyCount: number,
) =>
  budget === undefined ||
  (budget.remaining > 0 && keyCount <= Math.floor((budget.remaining - 1) / 2));

const consumeJsonStringLength = (
  value: string,
  budget: JsonEncodingBudget | undefined,
) => {
  if (budget === undefined) return true;
  if (!consumeJsonLength(budget, 2)) return false;

  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (
      codeUnit === 0x22 ||
      codeUnit === 0x5c ||
      codeUnit === 0x08 ||
      codeUnit === 0x09 ||
      codeUnit === 0x0a ||
      codeUnit === 0x0c ||
      codeUnit === 0x0d
    ) {
      if (!consumeJsonLength(budget, 2)) return false;
      continue;
    }
    if (codeUnit <= 0x1f) {
      if (!consumeJsonLength(budget, 6)) return false;
      continue;
    }
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const nextCodeUnit = value.charCodeAt(index + 1);
      if (nextCodeUnit >= 0xdc00 && nextCodeUnit <= 0xdfff) {
        if (!consumeJsonLength(budget, 2)) return false;
        index += 1;
      } else if (!consumeJsonLength(budget, 6)) {
        return false;
      }
      continue;
    }
    if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      if (!consumeJsonLength(budget, 6)) return false;
      continue;
    }
    if (!consumeJsonLength(budget, 1)) return false;
  }

  return true;
};

function encodeJsonValue(root: unknown): JsonToken[] | typeof invalidJsonValue;
function encodeJsonValue(
  root: unknown,
  maxSerializedLength: number,
  maxTokenCount?: number,
):
  | JsonToken[]
  | typeof invalidJsonValue
  | typeof jsonValueExceedsMaxLength
  | typeof jsonValueExceedsMaxTokenCount;
function encodeJsonValue(
  root: unknown,
  maxSerializedLength?: number,
  maxTokenCount?: number,
):
  | JsonToken[]
  | typeof invalidJsonValue
  | typeof jsonValueExceedsMaxLength
  | typeof jsonValueExceedsMaxTokenCount {
  const tokens: JsonToken[] = [];
  const ancestors = new WeakSet<object>();
  const pending: PendingJsonItem[] = [{ kind: 'value', value: root }];
  const budget =
    maxSerializedLength === undefined
      ? undefined
      : { remaining: maxSerializedLength };
  const tokenBudget =
    maxTokenCount === undefined ? undefined : { remaining: maxTokenCount };

  try {
    while (pending.length > 0) {
      const item = pending.pop();
      if (item === undefined) return invalidJsonValue;

      if (item.kind === 'key') {
        if (!consumeJsonLength(tokenBudget, 1)) {
          return jsonValueExceedsMaxTokenCount;
        }
        tokens.push(['key', item.key]);
        continue;
      }
      if (item.kind === 'array') {
        if (item.index === item.length) {
          ancestors.delete(item.value);
          continue;
        }
        const descriptor = Object.getOwnPropertyDescriptor(
          item.value,
          String(item.index),
        );
        if (!hasDataValue(descriptor) || !descriptor.enumerable) {
          return invalidJsonValue;
        }
        pending.push({ ...item, index: item.index + 1 });
        pending.push({ kind: 'value', value: descriptor.value });
        continue;
      }
      if (item.kind === 'object') {
        if (item.index === item.keys.length) {
          ancestors.delete(item.value);
          continue;
        }
        const key = item.keys[item.index];
        if (key === undefined) return invalidJsonValue;
        const descriptor = Object.getOwnPropertyDescriptor(item.value, key);
        if (!hasDataValue(descriptor) || !descriptor.enumerable) {
          return invalidJsonValue;
        }
        pending.push({ ...item, index: item.index + 1 });
        pending.push({ kind: 'value', value: descriptor.value });
        pending.push({ kind: 'key', key });
        continue;
      }

      const value = item.value;
      if (
        value === null ||
        typeof value === 'string' ||
        typeof value === 'boolean'
      ) {
        const withinBudget =
          typeof value === 'string'
            ? consumeJsonStringLength(value, budget)
            : consumeJsonLength(budget, value === null ? 4 : value ? 4 : 5);
        if (!withinBudget) return jsonValueExceedsMaxLength;
        if (!consumeJsonLength(tokenBudget, 1)) {
          return jsonValueExceedsMaxTokenCount;
        }
        tokens.push(['value', value]);
        continue;
      }
      if (typeof value === 'number') {
        if (!Number.isFinite(value)) return invalidJsonValue;
        if (!consumeJsonLength(budget, String(value).length)) {
          return jsonValueExceedsMaxLength;
        }
        if (!consumeJsonLength(tokenBudget, 1)) {
          return jsonValueExceedsMaxTokenCount;
        }
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

      if (isArray) {
        const lengthDescriptor = Object.getOwnPropertyDescriptor(
          value,
          'length',
        );
        if (!hasDataValue(lengthDescriptor)) return invalidJsonValue;
        const length = lengthDescriptor.value;
        if (!Number.isSafeInteger(length) || length < 0) {
          return invalidJsonValue;
        }

        if (!consumeJsonLength(budget, 2 + Math.max(0, length - 1))) {
          return jsonValueExceedsMaxLength;
        }
        if (!hasArrayTokenMinimum(tokenBudget, length)) {
          return jsonValueExceedsMaxTokenCount;
        }
        const keys = Reflect.ownKeys(value);
        if (keys.length !== length + 1) return invalidJsonValue;
        if (!consumeJsonLength(tokenBudget, 1)) {
          return jsonValueExceedsMaxTokenCount;
        }
        tokens.push(['array', length]);
        if (length > 0) {
          ancestors.add(value);
          pending.push({ kind: 'array', value, index: 0, length });
        }
        continue;
      }

      if (!consumeJsonLength(budget, 2)) {
        return jsonValueExceedsMaxLength;
      }
      const keys = Reflect.ownKeys(value);
      for (const key of keys) {
        if (typeof key !== 'string') return invalidJsonValue;
      }
      const stringKeys = keys as string[];

      if (!hasObjectTokenMinimum(tokenBudget, stringKeys.length)) {
        return jsonValueExceedsMaxTokenCount;
      }

      if (!consumeJsonLength(budget, Math.max(0, stringKeys.length - 1))) {
        return jsonValueExceedsMaxLength;
      }
      for (const key of stringKeys) {
        if (
          !consumeJsonStringLength(key, budget) ||
          !consumeJsonLength(budget, 1)
        ) {
          return jsonValueExceedsMaxLength;
        }
      }
      if (!consumeJsonLength(tokenBudget, 1)) {
        return jsonValueExceedsMaxTokenCount;
      }
      tokens.push(['object', stringKeys.length]);
      if (stringKeys.length > 0) {
        ancestors.add(value);
        pending.push({ kind: 'object', value, keys: stringKeys, index: 0 });
      }
    }
  } catch {
    return invalidJsonValue;
  }

  return tokens;
}

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

    const value: JsonValue = kind === 'array' ? [] : ({} as JsonObject);
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

export const createBoundedJsonValueSchema = (
  maxSerializedLength: number,
  maxTokenCount?: number,
) => {
  if (!Number.isSafeInteger(maxSerializedLength) || maxSerializedLength < 0) {
    throw new TypeError(
      'Maximum serialized JSON length must be a non-negative safe integer',
    );
  }
  if (
    maxTokenCount !== undefined &&
    (!Number.isSafeInteger(maxTokenCount) || maxTokenCount < 0)
  ) {
    throw new TypeError(
      'Maximum JSON token count must be a non-negative safe integer',
    );
  }

  const boundedJsonValueNormalizerSchema = z
    .unknown()
    .transform<JsonValue>((value, context) => {
      const encoded = encodeJsonValue(
        value,
        maxSerializedLength,
        maxTokenCount,
      );
      if (encoded === invalidJsonValue) {
        context.addIssue({ code: 'custom', message: 'Expected a JSON value' });
        return z.NEVER;
      }
      if (encoded === jsonValueExceedsMaxLength) {
        context.addIssue({
          code: 'custom',
          message: 'JSON value exceeds the maximum serialized length',
        });
        return z.NEVER;
      }
      if (encoded === jsonValueExceedsMaxTokenCount) {
        context.addIssue({
          code: 'custom',
          message: 'JSON value exceeds the maximum token count',
        });
        return z.NEVER;
      }
      return encoded as JsonValue;
    });

  return boundedJsonValueNormalizerSchema
    .pipe(z.json())
    .overwrite(decodeJsonValue);
};

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

export const createBoundedJsonObjectSchema = (
  maxSerializedLength: number,
  maxTokenCount?: number,
) => {
  if (!Number.isSafeInteger(maxSerializedLength) || maxSerializedLength < 0) {
    throw new TypeError(
      'Maximum serialized JSON length must be a non-negative safe integer',
    );
  }
  if (
    maxTokenCount !== undefined &&
    (!Number.isSafeInteger(maxTokenCount) || maxTokenCount < 0)
  ) {
    throw new TypeError(
      'Maximum JSON token count must be a non-negative safe integer',
    );
  }

  const normalizer = z.unknown().transform((value, context) => {
    const encoded = encodeJsonValue(value, maxSerializedLength, maxTokenCount);
    if (encoded === invalidJsonValue) {
      context.addIssue({ code: 'custom', message: 'Expected a JSON object' });
      return z.NEVER;
    }
    if (encoded === jsonValueExceedsMaxLength) {
      context.addIssue({
        code: 'custom',
        message: 'JSON value exceeds the maximum serialized length',
      });
      return z.NEVER;
    }
    if (encoded === jsonValueExceedsMaxTokenCount) {
      context.addIssue({
        code: 'custom',
        message: 'JSON value exceeds the maximum token count',
      });
      return z.NEVER;
    }
    if (encoded[0]?.[0] !== 'object') {
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

  return normalizer
    .pipe(jsonObjectOutputSchema)
    .overwrite((value) => decodeJsonValue(value['\u0000']) as JsonObject);
};

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
