import { z } from 'zod';

import { errorHttpMappings } from '../../src/errors.js';
import {
  contractRegistry,
  getSchemaSnapshotOutcome,
  type ContractRegistry,
} from '../../src/registry.js';
import { createJsonSchemaIr, type JsonSchemaObject } from './json-schema.js';

const OPENAPI_TITLE = 'Colorful Code API';
const CONTRACT_VERSION = '0.0.0';

type JsonObject = Record<string, unknown>;

const compareText = (left: string, right: string) =>
  left < right ? -1 : left > right ? 1 : 0;

const escapeJsonPointerSegment = (value: string): string =>
  value.replaceAll('~', '~0').replaceAll('/', '~1');

const nullObject = (): JsonObject => Object.create(null) as JsonObject;

const freezeJson = <Value>(value: Value): Value => {
  if (value === null || typeof value !== 'object') return value;
  for (const nested of Object.values(value)) freezeJson(nested);
  return Object.freeze(value);
};

const rewriteDefinitionReferences = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(rewriteDefinitionReferences);
  if (value === null || typeof value !== 'object') return value;

  const rewritten = nullObject();
  for (const [key, nested] of Object.entries(value)) {
    const rewrittenValue =
      key === '$ref' &&
      typeof nested === 'string' &&
      nested.startsWith('#/$defs/')
        ? `#/components/schemas/${nested.slice('#/$defs/'.length)}`
        : rewriteDefinitionReferences(nested);
    Object.defineProperty(rewritten, key, {
      configurable: true,
      enumerable: true,
      value: rewrittenValue,
      writable: true,
    });
  }
  return rewritten;
};

const schemaSignature = (schema: z.ZodType): string | undefined => {
  const snapshot = getSchemaSnapshotOutcome(schema);
  return snapshot?.jsonSchema === undefined
    ? undefined
    : JSON.stringify(snapshot.jsonSchema);
};

const operationComponentPrefix = (operationId: string): string =>
  operationId
    .split(/[^A-Za-z0-9]+/u)
    .filter((segment) => segment.length > 0)
    .map((segment) => `${segment[0]?.toUpperCase()}${segment.slice(1)}`)
    .join('');

const content = (schemaReference: string): JsonObject => ({
  'application/json': {
    schema: { $ref: schemaReference },
  },
});

const requiredProperties = (
  definition: JsonSchemaObject,
): ReadonlySet<string> =>
  new Set(
    Array.isArray(definition.required)
      ? definition.required.filter(
          (property): property is string => typeof property === 'string',
        )
      : [],
  );

const schemaProperties = (definition: JsonSchemaObject): JsonObject => {
  const { properties } = definition;
  return properties !== null &&
    typeof properties === 'object' &&
    !Array.isArray(properties)
    ? (properties as JsonObject)
    : nullObject();
};

type AtomicPropertyConstraint = Readonly<{
  pointer: readonly string[];
  schema: unknown;
}>;

type VariantProperty = readonly AtomicPropertyConstraint[];

type ObjectSchemaVariant = Readonly<{
  properties: ReadonlyMap<string, VariantProperty>;
  required: ReadonlySet<string>;
}>;

const unescapeJsonPointerSegment = (value: string): string =>
  value.replaceAll('~1', '/').replaceAll('~0', '~');

const localReferencePointer = (reference: string): readonly string[] => {
  if (!reference.startsWith('#/$defs/')) {
    throw new TypeError(
      `OpenAPI parameters cannot resolve non-local schema reference ${reference}`,
    );
  }
  return reference.slice(2).split('/').map(unescapeJsonPointerSegment);
};

const resolvePointer = (
  definitions: Readonly<Record<string, JsonSchemaObject>>,
  pointer: readonly string[],
): JsonSchemaObject => {
  let current: unknown = { $defs: definitions };
  for (const segment of pointer) {
    if (
      current === null ||
      typeof current !== 'object' ||
      !Object.hasOwn(current, segment)
    ) {
      throw new TypeError(
        `OpenAPI parameters contain unresolved local reference #/${pointer.map(escapeJsonPointerSegment).join('/')}`,
      );
    }
    current = (current as Record<string, unknown>)[segment];
  }
  if (
    current === null ||
    typeof current !== 'object' ||
    Array.isArray(current)
  ) {
    throw new TypeError(
      'OpenAPI parameter reference did not resolve to a schema',
    );
  }
  return current as JsonSchemaObject;
};

const mergeAllOfVariants = (
  left: ObjectSchemaVariant,
  right: ObjectSchemaVariant,
): ObjectSchemaVariant => {
  const properties = new Map(left.properties);
  for (const [name, candidate] of right.properties) {
    const existing = properties.get(name);
    if (existing === undefined) {
      properties.set(name, candidate);
      continue;
    }
    const pointers = new Set(
      existing.map((constraint) => JSON.stringify(constraint.pointer)),
    );
    properties.set(name, [
      ...existing,
      ...candidate.filter(
        (constraint) => !pointers.has(JSON.stringify(constraint.pointer)),
      ),
    ]);
  }
  return {
    properties,
    required: new Set([...left.required, ...right.required]),
  };
};

const objectSchemaVariants = (
  definition: JsonSchemaObject,
  definitions: Readonly<Record<string, JsonSchemaObject>>,
  pointer: readonly string[],
  resolving: ReadonlySet<string> = new Set(),
): readonly ObjectSchemaVariant[] => {
  const groups: Array<readonly ObjectSchemaVariant[]> = [];
  const reference = definition.$ref;
  if (reference !== undefined) {
    if (typeof reference !== 'string') {
      throw new TypeError('OpenAPI parameter schema $ref must be a string');
    }
    if (resolving.has(reference)) {
      throw new TypeError(
        `OpenAPI parameter schema reference cycle: ${reference}`,
      );
    }
    const targetPointer = localReferencePointer(reference);
    groups.push(
      objectSchemaVariants(
        resolvePointer(definitions, targetPointer),
        definitions,
        targetPointer.slice(1),
        new Set([...resolving, reference]),
      ),
    );
  }

  const properties = schemaProperties(definition);
  if (definition.type === 'object' || Object.keys(properties).length > 0) {
    groups.push([
      {
        properties: new Map(
          Object.entries(properties).map(([name, schema]) => [
            name,
            [{ pointer: [...pointer, 'properties', name], schema }],
          ]),
        ),
        required: requiredProperties(definition),
      },
    ]);
  }

  const allOf = definition.allOf;
  if (allOf !== undefined) {
    if (!Array.isArray(allOf)) {
      throw new TypeError('OpenAPI parameter schema allOf must be an array');
    }
    for (const [index, member] of allOf.entries()) {
      if (
        member === null ||
        typeof member !== 'object' ||
        Array.isArray(member)
      ) {
        throw new TypeError(
          `OpenAPI parameters contain non-object allOf member ${index}`,
        );
      }
      groups.push(
        objectSchemaVariants(
          member as JsonSchemaObject,
          definitions,
          [...pointer, 'allOf', String(index)],
          resolving,
        ),
      );
    }
  }

  for (const combinator of ['anyOf', 'oneOf'] as const) {
    const alternatives = definition[combinator];
    if (alternatives === undefined) continue;
    if (!Array.isArray(alternatives)) {
      throw new TypeError(
        `OpenAPI parameter schema ${combinator} must be an array`,
      );
    }
    groups.push(
      alternatives.flatMap((alternative, index) => {
        if (
          alternative === null ||
          typeof alternative !== 'object' ||
          Array.isArray(alternative)
        ) {
          throw new TypeError(
            `OpenAPI parameters contain non-object ${combinator} branch ${index}`,
          );
        }
        return objectSchemaVariants(
          alternative as JsonSchemaObject,
          definitions,
          [...pointer, combinator, String(index)],
          resolving,
        );
      }),
    );
  }

  if (groups.length === 0) {
    throw new TypeError('OpenAPI parameters require an object schema');
  }

  return groups.reduce<readonly ObjectSchemaVariant[]>(
    (combinations, group) =>
      combinations.flatMap((left) =>
        group.map((right) => mergeAllOfVariants(left, right)),
      ),
    [{ properties: new Map(), required: new Set() }],
  );
};

type ParameterProperty = Readonly<{
  name: string;
  required: boolean;
  schema: JsonObject;
}>;

const propertyConstraintSchema = (property: VariantProperty): JsonObject => {
  const references = property.map(({ pointer }) => ({
    $ref: `#/components/schemas/${pointer.map(escapeJsonPointerSegment).join('/')}`,
  }));
  return references.length === 1
    ? (references[0] as JsonObject)
    : { allOf: references };
};

const parameterProperties = (
  definition: JsonSchemaObject,
  definitions: Readonly<Record<string, JsonSchemaObject>>,
  componentName: string,
): readonly ParameterProperty[] => {
  const variants = objectSchemaVariants(definition, definitions, [
    componentName,
  ]);
  const occurrences = new Map<string, VariantProperty[]>();

  for (const variant of variants) {
    for (const [name, property] of variant.properties) {
      const existing = occurrences.get(name) ?? [];
      existing.push(property);
      occurrences.set(name, existing);
    }
  }

  return [...occurrences.entries()]
    .sort(([left], [right]) => compareText(left, right))
    .map(([name, candidates]) => {
      const [first] = candidates;
      if (first === undefined) throw new TypeError(`missing parameter ${name}`);
      const semanticSignatures = new Set(
        candidates.map((candidate) =>
          JSON.stringify(candidate.map(({ schema }) => schema)),
        ),
      );
      const schemas =
        semanticSignatures.size === 1
          ? [propertyConstraintSchema(first)]
          : candidates.map(propertyConstraintSchema);
      const uniqueSchemas = [
        ...new Map(
          schemas.map((schema) => [JSON.stringify(schema), schema]),
        ).values(),
      ];
      const required = variants.every(
        (variant) => variant.properties.has(name) && variant.required.has(name),
      );
      return {
        name,
        required,
        schema:
          uniqueSchemas.length === 1
            ? (uniqueSchemas[0] as JsonObject)
            : { anyOf: uniqueSchemas },
      };
    });
};

type ComponentRole = 'Path' | 'Query' | 'RequestBody' | 'Response';

const componentAliasRank = (name: string, role: ComponentRole): number => {
  if (role === 'Path') return name.endsWith('Path') ? 0 : 1;
  if (role === 'Query') {
    if (name.endsWith('Query')) return 0;
    if (name.endsWith('Params')) return 1;
    return 2;
  }
  if (role === 'RequestBody') return name.endsWith('Body') ? 0 : 1;
  if (name.endsWith('Response')) return 0;
  if (!/(?:Body|Params|Path|Query)$/u.test(name)) return 1;
  return 2;
};

export const createOpenApiDocument = (
  registry: ContractRegistry = contractRegistry,
) => {
  const descriptorEntries = Object.entries(registry.http).sort(
    ([left], [right]) => compareText(left, right),
  );
  const operationIds = new Map<
    string,
    Readonly<{ key: string; method: string; path: string }>
  >();
  const routes = new Map<
    string,
    Readonly<{ key: string; operationId: string }>
  >();
  for (const [key, descriptor] of descriptorEntries) {
    const method = descriptor.method.toLowerCase();
    const previousOperation = operationIds.get(descriptor.operationId);
    if (previousOperation !== undefined) {
      throw new TypeError(
        `duplicate operationId ${descriptor.operationId} between ${previousOperation.key} (${previousOperation.method} ${previousOperation.path}) and ${key} (${method} ${descriptor.path})`,
      );
    }
    operationIds.set(descriptor.operationId, {
      key,
      method,
      path: descriptor.path,
    });

    const routeKey = `${descriptor.path}\u0000${method}`;
    const previousRoute = routes.get(routeKey);
    if (previousRoute !== undefined) {
      throw new TypeError(
        `duplicate route ${method.toUpperCase()} ${descriptor.path} between ${previousRoute.operationId} (${previousRoute.key}) and ${descriptor.operationId} (${key})`,
      );
    }
    routes.set(routeKey, { key, operationId: descriptor.operationId });
  }

  const namedSchemas = Object.create(null) as Record<string, z.ZodType>;
  const namesBySignature = new Map<string, string[]>();

  for (const name of Object.keys(registry.schemas).sort(compareText)) {
    const schema = registry.schemas[name];
    if (schema === undefined) continue;
    Object.defineProperty(namedSchemas, name, {
      configurable: true,
      enumerable: true,
      value: schema,
      writable: true,
    });
    const signature = schemaSignature(schema);
    if (signature !== undefined) {
      const names = namesBySignature.get(signature) ?? [];
      names.push(name);
      namesBySignature.set(signature, names);
    }
  }

  const componentNameFor = (
    operationId: string,
    role: ComponentRole,
    schema: z.ZodType,
  ): string => {
    const aliases = namesBySignature.get(schemaSignature(schema) ?? '');
    const existingName =
      aliases === undefined
        ? undefined
        : [...aliases].sort(
            (left, right) =>
              componentAliasRank(left, role) -
                componentAliasRank(right, role) || compareText(left, right),
          )[0];
    if (existingName !== undefined) return existingName;

    const name = `${operationComponentPrefix(operationId)}${role}`;
    const existing = namedSchemas[name];
    if (existing !== undefined && existing !== schema) {
      throw new TypeError(`OpenAPI component name collision: ${name}`);
    }
    Object.defineProperty(namedSchemas, name, {
      configurable: true,
      enumerable: true,
      value: schema,
      writable: true,
    });
    return name;
  };

  const descriptors = descriptorEntries
    .map(([, descriptor]) => descriptor)
    .sort(
      (left, right) =>
        compareText(left.path, right.path) ||
        compareText(left.method, right.method) ||
        compareText(left.operationId, right.operationId),
    );
  const schemaNames = new Map<
    string,
    Readonly<{
      path?: string;
      query?: string;
      body?: string;
      response: string;
    }>
  >();

  for (const descriptor of descriptors) {
    schemaNames.set(
      descriptor.operationId,
      Object.freeze({
        ...(descriptor.pathSchema === undefined
          ? {}
          : {
              path: componentNameFor(
                descriptor.operationId,
                'Path',
                descriptor.pathSchema,
              ),
            }),
        ...(descriptor.querySchema === undefined
          ? {}
          : {
              query: componentNameFor(
                descriptor.operationId,
                'Query',
                descriptor.querySchema,
              ),
            }),
        ...(descriptor.bodySchema === undefined
          ? {}
          : {
              body: componentNameFor(
                descriptor.operationId,
                'RequestBody',
                descriptor.bodySchema,
              ),
            }),
        response: componentNameFor(
          descriptor.operationId,
          'Response',
          descriptor.resultSchema,
        ),
      }),
    );
  }

  const ir = createJsonSchemaIr(namedSchemas);
  const responses = nullObject();
  const errorStatuses = [
    ...new Set(errorHttpMappings.map(({ httpStatus }) => httpStatus)),
  ].sort((left, right) => left - right);
  for (const status of errorStatuses) {
    Object.defineProperty(responses, `ApiError${status}`, {
      configurable: true,
      enumerable: true,
      value: {
        description: `API error (${status})`,
        content: content('#/components/schemas/ApiError'),
      },
      writable: true,
    });
  }

  const paths = nullObject();
  for (const descriptor of descriptors) {
    let pathItem = paths[descriptor.path] as JsonObject | undefined;
    if (pathItem === undefined) {
      pathItem = nullObject();
      Object.defineProperty(paths, descriptor.path, {
        configurable: true,
        enumerable: true,
        value: pathItem,
        writable: true,
      });
    }

    const names = schemaNames.get(descriptor.operationId);
    if (names === undefined) {
      throw new TypeError(`missing schemas for ${descriptor.operationId}`);
    }
    const parameters: JsonObject[] = [];
    for (const [location, componentName] of [
      ['path', names.path],
      ['query', names.query],
    ] as const) {
      if (componentName === undefined) continue;
      const definition = ir.$defs[componentName];
      if (definition === undefined) {
        throw new TypeError(`missing OpenAPI component: ${componentName}`);
      }
      for (const property of parameterProperties(
        definition,
        ir.$defs,
        componentName,
      )) {
        parameters.push({
          in: location,
          name: property.name,
          required: location === 'path' || property.required,
          schema: property.schema,
        });
      }
    }

    const operationResponses = nullObject();
    const successStatus = descriptor.responseKind === 'commandAck' ? 202 : 200;
    Object.defineProperty(operationResponses, String(successStatus), {
      configurable: true,
      enumerable: true,
      value: {
        description:
          successStatus === 202 ? 'Command accepted' : 'Successful response',
        content: content(
          `#/components/schemas/${escapeJsonPointerSegment(names.response)}`,
        ),
      },
      writable: true,
    });
    for (const status of errorStatuses) {
      Object.defineProperty(operationResponses, String(status), {
        configurable: true,
        enumerable: true,
        value: { $ref: `#/components/responses/ApiError${status}` },
        writable: true,
      });
    }

    const operation: JsonObject = {
      operationId: descriptor.operationId,
      ...(parameters.length === 0 ? {} : { parameters }),
      ...(names.query === undefined
        ? {}
        : {
            'x-colorful-code-query-schema': {
              $ref: `#/components/schemas/${escapeJsonPointerSegment(names.query)}`,
            },
          }),
      ...(names.body === undefined
        ? {}
        : {
            requestBody: {
              required: true,
              content: content(
                `#/components/schemas/${escapeJsonPointerSegment(names.body)}`,
              ),
            },
          }),
      responses: operationResponses,
    };
    Object.defineProperty(pathItem, descriptor.method.toLowerCase(), {
      configurable: true,
      enumerable: true,
      value: operation,
      writable: true,
    });
  }

  const componentSchemas = Object.create(null) as Record<
    string,
    JsonSchemaObject
  >;
  for (const name of Object.keys(ir.$defs).sort(compareText)) {
    const definition = ir.$defs[name];
    if (definition === undefined) continue;
    Object.defineProperty(componentSchemas, name, {
      configurable: true,
      enumerable: true,
      value: rewriteDefinitionReferences(definition),
      writable: true,
    });
  }

  return freezeJson({
    openapi: '3.1.0' as const,
    info: { title: OPENAPI_TITLE, version: CONTRACT_VERSION },
    servers: [] as unknown[],
    paths,
    components: {
      schemas: componentSchemas,
      responses,
    },
  });
};
