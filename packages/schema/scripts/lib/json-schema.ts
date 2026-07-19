import { z } from 'zod';

import {
  getSchemaSnapshotOutcome,
  toIsolatedContractJsonSchema,
  unsupportedJsonSchemaPath,
} from '../../src/registry.js';

export type JsonSchemaObject = Readonly<Record<string, unknown>>;

export type JsonSchemaIr = Readonly<{
  $schema: 'https://json-schema.org/draft/2020-12/schema';
  $defs: Readonly<Record<string, JsonSchemaObject>>;
}>;

const jsonSchemaObject = (value: unknown): Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('converter returned a non-object JSON Schema');
  }
  return value as Record<string, unknown>;
};

const escapeJsonPointerSegment = (value: string): string =>
  value.replaceAll('~', '~0').replaceAll('/', '~1');

const unescapeJsonPointerSegment = (value: string): string =>
  value.replaceAll('~1', '/').replaceAll('~0', '~');

const rewriteInternalReferences = (
  value: unknown,
  internalNames: ReadonlyMap<string, string>,
  rootName: string,
): unknown => {
  if (Array.isArray(value)) {
    return value.map((item) =>
      rewriteInternalReferences(item, internalNames, rootName),
    );
  }
  if (value === null || typeof value !== 'object') return value;

  const rewritten = Object.create(null) as Record<string, unknown>;
  for (const [key, nested] of Object.entries(value)) {
    if (key === '$ref' && typeof nested === 'string') {
      const prefix = '#/$defs/';
      const internalName = nested.startsWith(prefix)
        ? unescapeJsonPointerSegment(nested.slice(prefix.length))
        : undefined;
      rewritten[key] =
        nested === '#'
          ? `#/$defs/${escapeJsonPointerSegment(rootName)}`
          : internalName === undefined
            ? nested
            : `#/$defs/${escapeJsonPointerSegment(
                internalNames.get(internalName) ?? internalName,
              )}`;
    } else {
      rewritten[key] = rewriteInternalReferences(
        nested,
        internalNames,
        rootName,
      );
    }
  }
  return rewritten;
};

const freezeJson = <Value>(value: Value): Value => {
  if (value === null || typeof value !== 'object') return value;
  for (const nested of Object.values(value)) freezeJson(nested);
  return Object.freeze(value);
};

const compareText = (left: string, right: string) =>
  left < right ? -1 : left > right ? 1 : 0;

export const createJsonSchemaIr = <
  const Schemas extends Readonly<Record<string, z.ZodType>>,
>(
  schemas: Schemas,
): JsonSchemaIr => {
  const definitions = Object.create(null) as Record<string, JsonSchemaObject>;
  const topLevelNames = new Set(Object.keys(schemas));

  for (const name of Object.keys(schemas).sort()) {
    const schema = schemas[name];
    if (schema === undefined) continue;
    const snapshot = getSchemaSnapshotOutcome(schema);
    const unsupportedPath =
      snapshot === undefined
        ? unsupportedJsonSchemaPath(schema)
        : snapshot.unsupportedPath;
    if (unsupportedPath !== undefined) {
      throw new TypeError(
        `${name} at ${unsupportedPath}: unsupported Zod node cannot be represented without widening the contract`,
      );
    }

    let converted: Record<string, unknown>;
    if (snapshot?.conversionError !== undefined) {
      throw new TypeError(
        `${name} at $: JSON Schema conversion failed: ${snapshot.conversionError}`,
      );
    } else if (snapshot?.jsonSchema !== undefined) {
      converted = jsonSchemaObject(snapshot.jsonSchema);
    } else {
      try {
        converted = jsonSchemaObject(toIsolatedContractJsonSchema(schema));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new TypeError(
          `${name} at $: JSON Schema conversion failed: ${message}`,
        );
      }
    }

    const nestedDefinitions = converted.$defs;
    const definition = Object.fromEntries(
      Object.entries(converted).filter(
        ([key]) => key !== '$defs' && key !== '$schema',
      ),
    );
    const nested =
      nestedDefinitions === undefined
        ? (Object.create(null) as Record<string, unknown>)
        : jsonSchemaObject(nestedDefinitions);
    const internalNames = new Map(
      Object.keys(nested).map((nestedName) => [
        nestedName,
        `${name}__${nestedName}`,
      ]),
    );

    definitions[name] = jsonSchemaObject(
      rewriteInternalReferences(definition, internalNames, name),
    );
    for (const nestedName of Object.keys(nested).sort()) {
      const qualifiedName = internalNames.get(nestedName);
      if (qualifiedName === undefined) continue;
      if (topLevelNames.has(qualifiedName)) {
        throw new TypeError(
          `${name} nested definition ${nestedName} collides with top-level schema ${qualifiedName}`,
        );
      }
      definitions[qualifiedName] = jsonSchemaObject(
        rewriteInternalReferences(nested[nestedName], internalNames, name),
      );
    }
  }

  const orderedDefinitions = Object.create(null) as Record<
    string,
    JsonSchemaObject
  >;
  for (const [name, definition] of Object.entries(definitions).sort(
    ([left], [right]) => compareText(left, right),
  )) {
    Object.defineProperty(orderedDefinitions, name, {
      configurable: true,
      enumerable: true,
      value: definition,
      writable: true,
    });
  }

  return freezeJson({
    $schema: 'https://json-schema.org/draft/2020-12/schema' as const,
    $defs: orderedDefinitions,
  });
};
