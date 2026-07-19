import { z } from 'zod';

import {
  canonicalNonBlankStringSchema,
  configRevisionSchema,
  jsonValueSchema,
  strictObjectSchema,
  timestampSchema,
} from './common.js';
import { credentialRefIdSchema } from './ids.js';

const boundedConfigNameSchema = z.string().trim().min(1).max(256);
export const credentialRefSchema = strictObjectSchema({
  credentialRef: credentialRefIdSchema,
  provider: canonicalNonBlankStringSchema,
  label: canonicalNonBlankStringSchema,
  createdAt: timestampSchema,
});
export type CredentialRef = z.infer<typeof credentialRefSchema>;

const SENSITIVE_PROVIDER_OPTION_KEYS = Object.freeze([
  'secret',
  'apikey',
  'accesstoken',
  'refreshtoken',
  'password',
  'privatekey',
  'authorization',
  'cookie',
  'credentialvalue',
] as const);
const normalizedSensitiveProviderOptionKeys = new Set<string>(
  SENSITIVE_PROVIDER_OPTION_KEYS,
);

const ignoredProviderOptionKeyCharacters =
  /[\p{Mark}\p{Punctuation}\p{Separator}\p{Format}]/gu;

const normalizeProviderOptionKey = (key: string) =>
  key
    .normalize('NFKC')
    .toLowerCase()
    .replace(ignoredProviderOptionKeyCharacters, '');

type ProviderOptionPathNode = {
  key: string | number;
  parent?: ProviderOptionPathNode;
};

const providerOptionPath = (node: ProviderOptionPathNode) => {
  const reversedPath: PropertyKey[] = [];
  let current: ProviderOptionPathNode | undefined = node;
  while (current !== undefined) {
    reversedPath.push(current.key);
    current = current.parent;
  }
  return reversedPath.reverse();
};

type ProviderOptionFrame =
  | {
      index: number;
      kind: 'array';
      path?: ProviderOptionPathNode;
      value: unknown[];
    }
  | {
      entries: Generator<readonly [string, unknown], void>;
      kind: 'object';
      path?: ProviderOptionPathNode;
    };

const ownDataEntries = function* (
  value: object,
): Generator<readonly [string, unknown], void> {
  for (const key in value) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor !== undefined &&
      descriptor.enumerable &&
      'value' in descriptor
    ) {
      yield [key, descriptor.value] as const;
    }
  }
};

const providerOptionFrame = (
  value: unknown,
  path?: ProviderOptionPathNode,
): ProviderOptionFrame | undefined => {
  if (Array.isArray(value)) {
    return { index: 0, kind: 'array', path, value };
  }
  if (value !== null && typeof value === 'object') {
    return { entries: ownDataEntries(value), kind: 'object', path };
  }
  return undefined;
};

const providerOptionsSchema = jsonValueSchema.superRefine((root, context) => {
  const rootFrame = providerOptionFrame(root);
  if (rootFrame === undefined) return;
  const pending: ProviderOptionFrame[] = [rootFrame];

  while (pending.length > 0) {
    const frame = pending.at(-1);
    if (frame === undefined) break;

    if (frame.kind === 'array') {
      if (frame.index >= frame.value.length) {
        pending.pop();
        continue;
      }
      const index = frame.index;
      frame.index += 1;
      const path = { key: index, parent: frame.path };
      const childFrame = providerOptionFrame(frame.value[index], path);
      if (childFrame !== undefined) pending.push(childFrame);
      continue;
    }

    const entry = frame.entries.next();
    if (entry.done) {
      pending.pop();
      continue;
    }

    const [key, value] = entry.value;
    const path = { key, parent: frame.path };
    if (
      normalizedSensitiveProviderOptionKeys.has(normalizeProviderOptionKey(key))
    ) {
      context.addIssue({
        code: 'custom',
        message: 'provider option key is not allowed',
        path: providerOptionPath(path),
      });
      continue;
    }
    const childFrame = providerOptionFrame(value, path);
    if (childFrame !== undefined) pending.push(childFrame);
  }
});

const PROVIDER_OPTIONS_METADATA = Object.freeze({
  'x-colorful-forbiddenPropertyNames': SENSITIVE_PROVIDER_OPTION_KEYS,
  'x-colorful-propertyNameNormalization':
    'nfkc-lowercase-strip-mark-punctuation-separator-format',
});
const CONFIG_PATCH_METADATA = Object.freeze({ minProperties: 1 });

export const reasoningEffortSchema = z.enum(['low', 'medium', 'high']);
export type ReasoningEffort = z.infer<typeof reasoningEffortSchema>;

export const configPatchSchema = strictObjectSchema({
  model: boundedConfigNameSchema.optional(),
  provider: boundedConfigNameSchema.optional(),
  providerCredentialRef: credentialRefIdSchema.nullable().optional(),
  temperature: z.number().finite().min(0).max(2).optional(),
  topP: z.number().finite().min(0).max(1).optional(),
  maxOutputTokens: z.number().int().positive().safe().optional(),
  reasoningEffort: reasoningEffortSchema.optional(),
  providerOptions: providerOptionsSchema.optional(),
}).refine(
  (patch) => Object.values(patch).some((value) => value !== undefined),
  {
    message: 'at least one config field is required',
  },
);
export type ConfigPatch = z.infer<typeof configPatchSchema>;

const CONFIG_METADATA_DESCRIPTORS = Object.freeze([
  Object.freeze([providerOptionsSchema, PROVIDER_OPTIONS_METADATA] as const),
  Object.freeze([configPatchSchema, CONFIG_PATCH_METADATA] as const),
] as const);

export const registerConfigContractMetadata = (
  metadata: z.core.$ZodRegistry<Record<string, unknown>>,
) => {
  for (const [describedSchema, descriptor] of CONFIG_METADATA_DESCRIPTORS) {
    metadata.add(describedSchema, descriptor);
  }
};

export const configRevisionResultSchema = strictObjectSchema({
  configRevision: configRevisionSchema,
});
export type ConfigRevisionResult = z.infer<typeof configRevisionResultSchema>;
