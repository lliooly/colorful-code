export class SchemaValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SchemaValidationError";
  }
}

export type Schema<T> = {
  parse(input: unknown): T;
};

export type FieldParser<T> = {
  parse(value: unknown, key: string): T;
};

type InferField<T> = T extends FieldParser<infer Value> ? Value : never;

type ObjectFromShape<Shape extends Record<string, FieldParser<unknown>>> = {
  [Key in keyof Shape]: InferField<Shape[Key]>;
};

export function unknownField(): FieldParser<unknown> {
  return {
    parse(value) {
      return value;
    },
  };
}

export function stringField(): FieldParser<string> {
  return {
    parse(value, key) {
      if (typeof value !== "string") {
        throw new SchemaValidationError("Invalid input: " + key + " must be a string");
      }
      return value;
    },
  };
}

export function numberField(): FieldParser<number> {
  return {
    parse(value, key) {
      if (typeof value !== "number" || Number.isNaN(value)) {
        throw new SchemaValidationError("Invalid input: " + key + " must be a number");
      }
      return value;
    },
  };
}

export function booleanField(): FieldParser<boolean> {
  return {
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
  return {
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
    parse(input) {
      if (typeof input !== "object" || input === null || Array.isArray(input)) {
        throw new SchemaValidationError("Invalid input: expected an object");
      }
      return input as Record<string, unknown>;
    },
  };
}
