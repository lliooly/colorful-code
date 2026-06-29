export class SchemaValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SchemaValidationError";
  }
}

export type JsonSchemaNode = { type?: string; [k: string]: unknown };

export type ToolInputJSONSchema = {
  type: "object";
  properties?: Record<string, JsonSchemaNode>;
  required?: string[];
  additionalProperties?: boolean;
  [k: string]: unknown;
};

export type Schema<T> = {
  parse(input: unknown): T;
  readonly jsonSchema: ToolInputJSONSchema;
};

export type FieldParser<T> = {
  parse(value: unknown, key: string): T;
  readonly jsonSchema: JsonSchemaNode;
  readonly optional?: boolean;
};

export type ScalarFieldOptions = {
  description?: string;
};

type InferField<T> = T extends FieldParser<infer Value> ? Value : never;

type ObjectFromShape<Shape extends Record<string, FieldParser<unknown>>> = {
  [Key in keyof Shape]: InferField<Shape[Key]>;
};

function describe(node: JsonSchemaNode, options?: ScalarFieldOptions): JsonSchemaNode {
  if (options?.description !== undefined) {
    return { ...node, description: options.description };
  }
  return node;
}

export function unknownField(): FieldParser<unknown> {
  return {
    jsonSchema: {},
    parse(value) {
      return value;
    },
  };
}

export function stringField(options?: ScalarFieldOptions): FieldParser<string> {
  return {
    jsonSchema: describe({ type: "string" }, options),
    parse(value, key) {
      if (typeof value !== "string") {
        throw new SchemaValidationError("Invalid input: " + key + " must be a string");
      }
      return value;
    },
  };
}

export function numberField(options?: ScalarFieldOptions): FieldParser<number> {
  return {
    jsonSchema: describe({ type: "number" }, options),
    parse(value, key) {
      if (typeof value !== "number" || Number.isNaN(value)) {
        throw new SchemaValidationError("Invalid input: " + key + " must be a number");
      }
      return value;
    },
  };
}

export function booleanField(options?: ScalarFieldOptions): FieldParser<boolean> {
  return {
    jsonSchema: describe({ type: "boolean" }, options),
    parse(value, key) {
      if (typeof value !== "boolean") {
        throw new SchemaValidationError("Invalid input: " + key + " must be a boolean");
      }
      return value;
    },
  };
}

export function optionalField<T>(field: FieldParser<T>): FieldParser<T | undefined> {
  return {
    jsonSchema: field.jsonSchema,
    optional: true,
    parse(value, key) {
      if (value === undefined) {
        return undefined;
      }
      return field.parse(value, key);
    },
  };
}

export function arrayField<T>(field: FieldParser<T>): FieldParser<T[]> {
  return {
    jsonSchema: { type: "array", items: field.jsonSchema },
    parse(value, key) {
      if (!Array.isArray(value)) {
        throw new SchemaValidationError("Invalid input: " + key + " must be an array");
      }
      return value.map((item, index) => field.parse(item, key + "[" + index + "]"));
    },
  };
}

export function objectField(): FieldParser<Record<string, unknown>> {
  return {
    jsonSchema: { type: "object" },
    parse(value, key) {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new SchemaValidationError("Invalid input: " + key + " must be an object");
      }
      return value as Record<string, unknown>;
    },
  };
}

export function objectSchema<Shape extends Record<string, FieldParser<unknown>>>(
  shape: Shape,
): Schema<ObjectFromShape<Shape>> {
  const properties: Record<string, JsonSchemaNode> = {};
  const required: string[] = [];
  for (const [key, parser] of Object.entries(shape)) {
    properties[key] = parser.jsonSchema;
    if (parser.optional !== true) {
      required.push(key);
    }
  }

  const jsonSchema: ToolInputJSONSchema = {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  };

  return {
    jsonSchema,
    parse(input) {
      if (typeof input !== "object" || input === null || Array.isArray(input)) {
        throw new SchemaValidationError("Invalid input: expected an object");
      }

      const source = input as Record<string, unknown>;
      const output: Record<string, unknown> = {};
      for (const [key, parser] of Object.entries(shape)) {
        output[key] = parser.parse(source[key], key);
      }
      return output as ObjectFromShape<Shape>;
    },
  };
}

export function passthroughObjectSchema(): Schema<Record<string, unknown>> {
  return {
    jsonSchema: { type: "object", additionalProperties: true },
    parse(input) {
      if (typeof input !== "object" || input === null || Array.isArray(input)) {
        throw new SchemaValidationError("Invalid input: expected an object");
      }
      return input as Record<string, unknown>;
    },
  };
}
