import type { JsonSchemaIr, JsonSchemaObject } from './json-schema.js';

const HEADER = '// This file is generated. Do not edit.';
const compareText = (left: string, right: string) =>
  left < right ? -1 : left > right ? 1 : 0;

const SWIFT_KEYWORDS = new Set([
  'associatedtype',
  'class',
  'deinit',
  'enum',
  'extension',
  'fileprivate',
  'func',
  'import',
  'init',
  'inout',
  'internal',
  'let',
  'open',
  'operator',
  'private',
  'protocol',
  'public',
  'rethrows',
  'static',
  'struct',
  'subscript',
  'typealias',
  'var',
  'break',
  'case',
  'continue',
  'default',
  'defer',
  'do',
  'else',
  'fallthrough',
  'for',
  'guard',
  'if',
  'in',
  'repeat',
  'return',
  'switch',
  'where',
  'while',
  'as',
  'Any',
  'catch',
  'false',
  'is',
  'nil',
  'super',
  'self',
  'Self',
  'throw',
  'throws',
  'true',
  'try',
  '_',
]);

const words = (value: string): string[] => {
  const normalized = value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .trim();
  return normalized.length === 0 ? ['value'] : normalized.split(/\s+/);
};

const upperFirst = (value: string) =>
  `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
const lowerFirst = (value: string) =>
  `${value.slice(0, 1).toLowerCase()}${value.slice(1)}`;
const bareTypeName = (value: string) =>
  words(value)
    .map((word) => upperFirst(word))
    .join('')
    .replace(/^[0-9]/, '_$&');
const bareMemberName = (value: string) => {
  const [first = 'value', ...rest] = words(value);
  return `${lowerFirst(first)}${rest.map(upperFirst).join('')}`.replace(
    /^[0-9]/,
    '_$&',
  );
};
const escapedMember = (value: string) => {
  const identifier = bareMemberName(value);
  return SWIFT_KEYWORDS.has(identifier) ? `\`${identifier}\`` : identifier;
};
const swiftString = (value: string) => JSON.stringify(value);

const ECMASCRIPT_WHITESPACE =
  '\\u0009-\\u000D\\u0020\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF';

const swiftRegularExpression = (pattern: string): string => {
  const normalized = pattern
    .replaceAll('[\\s\\S]', '(?s:.)')
    .replaceAll('[\\S\\s]', '(?s:.)');
  let result = '';
  let characterClass = false;
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index]!;
    if (character === '[') characterClass = true;
    if (character === ']') characterClass = false;
    if (character !== '\\') {
      result += character;
      continue;
    }
    const escaped = normalized[index + 1];
    if (escaped === undefined) {
      throw new TypeError('unsupported dangling Swift regex escape');
    }
    if (escaped === 'd') {
      if (characterClass) {
        throw new TypeError('unsupported Swift regex digit class escape');
      }
      result += '[0-9]';
      index += 1;
      continue;
    }
    if (escaped === 's' || escaped === 'S') {
      if (characterClass) {
        throw new TypeError('unsupported Swift regex whitespace class escape');
      }
      result +=
        escaped === 's'
          ? `[${ECMASCRIPT_WHITESPACE}]`
          : `[^${ECMASCRIPT_WHITESPACE}]`;
      index += 1;
      continue;
    }
    result += `\\${escaped}`;
    index += 1;
  }
  if (characterClass) throw new TypeError('unterminated Swift regex class');
  return result;
};

const objectValue = (value: unknown): JsonSchemaObject | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonSchemaObject)
    : undefined;
const objectArray = (value: unknown): JsonSchemaObject[] | undefined =>
  Array.isArray(value)
    ? value
        .map(objectValue)
        .filter((item): item is JsonSchemaObject => item !== undefined)
    : undefined;

const refName = (reference: string): string => {
  const prefix = '#/$defs/';
  if (!reference.startsWith(prefix)) {
    throw new TypeError(`unsupported Swift schema reference: ${reference}`);
  }
  return reference
    .slice(prefix.length)
    .replaceAll('~1', '/')
    .replaceAll('~0', '~');
};

const runtime = `
import Foundation

public indirect enum JSONValue: Codable, Sendable {
  case string(String)
  case number(Double)
  case bool(Bool)
  case null
  case array([JSONValue])
  case object([String: JSONValue])

  public init(from decoder: Decoder) throws {
    let container = try decoder.singleValueContainer()
    if container.decodeNil() { self = .null }
    else if let value = try? container.decode(Bool.self) { self = .bool(value) }
    else if let value = try? container.decode(Double.self) { self = .number(value) }
    else if let value = try? container.decode(String.self) { self = .string(value) }
    else if let value = try? container.decode([JSONValue].self) { self = .array(value) }
    else if let value = try? container.decode([String: JSONValue].self) { self = .object(value) }
    else { throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Expected a JSON value")) }
  }

  public func encode(to encoder: Encoder) throws {
    var container = encoder.singleValueContainer()
    switch self {
    case .string(let value): try container.encode(value)
    case .number(let value): try container.encode(value)
    case .bool(let value): try container.encode(value)
    case .null: try container.encodeNil()
    case .array(let value): try container.encode(value)
    case .object(let value): try container.encode(value)
    }
  }
}

public struct JSONNull: Codable, Sendable {
  public init(from decoder: Decoder) throws {
    let container = try decoder.singleValueContainer()
    guard container.decodeNil() else {
      throw DecodingError.valueNotFound(JSONNull.self, .init(codingPath: decoder.codingPath, debugDescription: "Expected null"))
    }
  }

  public func encode(to encoder: Encoder) throws {
    var container = encoder.singleValueContainer()
    try container.encodeNil()
  }
}

struct AnyCodingKey: CodingKey {
  let stringValue: String
  let intValue: Int?
  init(stringValue: String) { self.stringValue = stringValue; self.intValue = nil }
  init(intValue: Int) { self.stringValue = String(intValue); self.intValue = intValue }
}

private func rejectUnknownKeys(_ decoder: Decoder, allowed: Set<String>) throws {
  let container = try decoder.container(keyedBy: AnyCodingKey.self)
  let unknown = container.allKeys.map(\\.stringValue).filter { !allowed.contains($0) }.sorted()
  if !unknown.isEmpty {
    throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Unknown keys: \\(unknown.joined(separator: ", "))"))
  }
}

private func decodeJSONValue<Value: Decodable>(_ type: Value.Type, from value: JSONValue) throws -> Value {
  try JSONDecoder().decode(type, from: JSONEncoder().encode(value))
}

private func encodeJSONValue<Value: Encodable>(_ value: Value) throws -> JSONValue {
  try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(value))
}

private func normalizedProviderOptionKey(_ value: String) -> String {
  var result = ""
  for scalar in value.precomposedStringWithCompatibilityMapping.lowercased().unicodeScalars {
    switch scalar.properties.generalCategory {
    case .nonspacingMark, .spacingMark, .enclosingMark,
      .connectorPunctuation, .dashPunctuation, .openPunctuation,
      .closePunctuation, .initialPunctuation, .finalPunctuation,
      .otherPunctuation, .spaceSeparator, .lineSeparator,
      .paragraphSeparator, .format:
      continue
    default:
      result.unicodeScalars.append(scalar)
    }
  }
  return result
}

private func rejectForbiddenPropertyNames(
  _ root: JSONValue,
  forbidden: Set<String>
) throws {
  var pending = [root]
  while let value = pending.popLast() {
    switch value {
    case .array(let values): pending.append(contentsOf: values)
    case .object(let object):
      for (key, child) in object {
        guard !forbidden.contains(normalizedProviderOptionKey(key)) else {
          throw DecodingError.dataCorrupted(.init(codingPath: [], debugDescription: "Forbidden property name"))
        }
        pending.append(child)
      }
    default: break
    }
  }
}

@propertyWrapper
public struct RequiredNullable<Value: Codable & Sendable>: Codable, Sendable {
  public var wrappedValue: Value?

  public init(wrappedValue: Value?) {
    self.wrappedValue = wrappedValue
  }

  public init(from decoder: Decoder) throws {
    let container = try decoder.singleValueContainer()
    self.wrappedValue = container.decodeNil() ? nil : try container.decode(Value.self)
  }

  public func encode(to encoder: Encoder) throws {
    var container = encoder.singleValueContainer()
    if let wrappedValue { try container.encode(wrappedValue) }
    else { try container.encodeNil() }
  }
}

public enum Presence<Value: Codable & Sendable>: Codable, Sendable {
  case absent
  case null
  case value(Value)

  public init(from decoder: Decoder) throws {
    let container = try decoder.singleValueContainer()
    self = container.decodeNil() ? .null : .value(try container.decode(Value.self))
  }

  public func encode(to encoder: Encoder) throws {
    var container = encoder.singleValueContainer()
    switch self {
    case .absent: throw EncodingError.invalidValue(self, .init(codingPath: encoder.codingPath, debugDescription: "Absent presence must be omitted by its keyed container"))
    case .null: try container.encodeNil()
    case .value(let value): try container.encode(value)
    }
  }
}
`;

type NullableType = { nullable: boolean; schema: JsonSchemaObject };

class SwiftEmitter {
  readonly #definitions: Readonly<Record<string, JsonSchemaObject>>;
  readonly #topNames = new Map<string, string>();
  readonly #usedNames = new Set<string>([
    'JSONValue',
    'JSONNull',
    'Presence',
    'RequiredNullable',
    'AnyCodingKey',
  ]);
  readonly #declarations = new Map<string, string>();
  readonly #emitting = new Set<string>();

  constructor(definitions: Readonly<Record<string, JsonSchemaObject>>) {
    this.#definitions = definitions;
    for (const name of Object.keys(definitions).sort(compareText)) {
      if (name === 'JsonValue') this.#topNames.set(name, 'JSONValue');
      else this.#topNames.set(name, this.#claimName(bareTypeName(name)));
    }
  }

  emit(): string {
    for (const name of Object.keys(this.#definitions).sort(compareText)) {
      const schema = this.#definitions[name];
      const swiftName = this.#topNames.get(name);
      if (schema !== undefined && swiftName !== undefined)
        this.#emitNamed(swiftName, schema);
    }
    return `${[HEADER, runtime.trim(), ...this.#declarations.values()].join(
      '\n\n',
    )}\n`;
  }

  #claimName(preferred: string): string {
    let candidate = preferred;
    let suffix = 2;
    while (this.#usedNames.has(candidate))
      candidate = `${preferred}${suffix++}`;
    this.#usedNames.add(candidate);
    return candidate;
  }

  #nestedName(hint: string): string {
    return this.#claimName(bareTypeName(hint));
  }

  #nullable(schema: JsonSchemaObject): NullableType {
    const anyOf = objectArray(schema.anyOf);
    if (anyOf === undefined) return { nullable: false, schema };
    const nonNull = anyOf.filter((item) => item.type !== 'null');
    if (nonNull.length === 1 && nonNull.length !== anyOf.length) {
      return { nullable: true, schema: nonNull[0]! };
    }
    return { nullable: false, schema };
  }

  #type(schema: JsonSchemaObject, hint: string): string {
    if (typeof schema.$ref === 'string') {
      const name = refName(schema.$ref);
      const mapped = this.#topNames.get(name);
      if (mapped === undefined)
        throw new TypeError(`unmapped Swift schema reference: ${name}`);
      return mapped;
    }
    const nullable = this.#nullable(schema);
    if (nullable.nullable) return `${this.#type(nullable.schema, hint)}?`;
    if (schema.type === 'string' && Array.isArray(schema.enum)) {
      const name = this.#nestedName(hint);
      this.#emitNamed(name, schema);
      return name;
    }
    if (schema.type === 'string') return 'String';
    if (schema.type === 'boolean') return 'Bool';
    if (schema.type === 'integer') return 'Int';
    if (schema.type === 'number') return 'Double';
    if (schema.type === 'null') return 'JSONNull';
    if (schema.type === 'array') {
      const items = objectValue(schema.items);
      if (items === undefined)
        throw new TypeError(`${hint}: array is missing an item schema`);
      return `[${this.#type(items, `${hint}Item`)}]`;
    }
    if (schema.type === 'object') {
      const properties = objectValue(schema.properties);
      if (properties === undefined || Object.keys(properties).length === 0) {
        const additional = objectValue(schema.additionalProperties);
        return additional === undefined
          ? '[String: JSONValue]'
          : `[String: ${this.#type(additional, `${hint}Value`)}]`;
      }
      const name = this.#nestedName(hint);
      this.#emitNamed(name, schema);
      return name;
    }
    if (
      objectArray(schema.oneOf) !== undefined ||
      objectArray(schema.anyOf) !== undefined
    ) {
      const name = this.#nestedName(hint);
      this.#emitNamed(name, schema);
      return name;
    }
    if (objectValue(schema.not) !== undefined) {
      const name = this.#nestedName(hint);
      this.#declarations.set(name, this.#never(name));
      return name;
    }
    if (Object.keys(schema).length === 0) return 'JSONValue';
    throw new TypeError(
      `${hint}: unsupported JSON Schema node ${Object.keys(schema).sort().join(', ')}`,
    );
  }

  #emitNamed(name: string, schema: JsonSchemaObject): void {
    if (
      name === 'JSONValue' ||
      this.#declarations.has(name) ||
      this.#emitting.has(name)
    )
      return;
    this.#emitting.add(name);
    let declaration: string;
    if (schema.type === 'string' && Array.isArray(schema.enum))
      declaration = this.#stringEnum(name, schema.enum);
    else if (
      schema.type === 'object' &&
      objectValue(schema.properties) !== undefined
    )
      declaration = this.#struct(name, schema);
    else if (
      objectArray(schema.oneOf) !== undefined ||
      objectArray(schema.anyOf) !== undefined
    )
      declaration = this.#union(name, schema);
    else if (objectValue(schema.not) !== undefined)
      declaration = this.#never(name);
    else
      declaration = `public typealias ${name} = ${this.#type(schema, `${name}Value`)}`;
    this.#declarations.set(name, declaration);
    this.#emitting.delete(name);
  }

  #stringEnum(name: string, values: unknown[]): string {
    const normalized = new Map<string, string>();
    const cases = values.map((value) => {
      if (typeof value !== 'string')
        throw new TypeError(`${name}: non-string enum case`);
      const identifier = escapedMember(value);
      const normalizedIdentifier = identifier.replaceAll('`', '');
      const existing = normalized.get(normalizedIdentifier);
      if (existing !== undefined)
        throw new TypeError(
          `${name}: enum case collision between ${existing} and ${value}`,
        );
      normalized.set(normalizedIdentifier, value);
      const needsRawValue =
        identifier.includes('`') || identifier.replaceAll('`', '') !== value;
      return `  case ${identifier}${needsRawValue ? ` = ${swiftString(value)}` : ''}`;
    });
    return [
      `public enum ${name}: String, Codable, Sendable {`,
      ...cases,
      '}',
    ].join('\n');
  }

  #struct(name: string, schema: JsonSchemaObject): string {
    const properties = objectValue(schema.properties) ?? {};
    const required = new Set(
      Array.isArray(schema.required)
        ? schema.required.filter(
            (item): item is string => typeof item === 'string',
          )
        : [],
    );
    const propertyEntries = Object.entries(properties).sort(([left], [right]) =>
      compareText(left, right),
    );
    const normalizedMembers = new Map<string, string>();
    for (const [wire] of propertyEntries) {
      const member = escapedMember(wire).replaceAll('`', '');
      const existing = normalizedMembers.get(member);
      if (existing !== undefined)
        throw new TypeError(
          `${name}: member collision between ${existing} and ${wire}`,
        );
      normalizedMembers.set(member, wire);
    }
    const entries = propertyEntries.map(([wire, value]) => {
      const property = objectValue(value);
      if (property === undefined)
        throw new TypeError(
          `${name}.${wire}: property schema is not an object`,
        );
      const nullable = this.#nullable(property);
      const base = this.#type(nullable.schema, `${name}${bareTypeName(wire)}`);
      const isRequired = required.has(wire);
      const forbiddenPropertyNames =
        property['x-colorful-forbiddenPropertyNames'];
      const propertyNameNormalization =
        property['x-colorful-propertyNameNormalization'];
      if (
        forbiddenPropertyNames !== undefined &&
        (!Array.isArray(forbiddenPropertyNames) ||
          forbiddenPropertyNames.length === 0 ||
          forbiddenPropertyNames.some(
            (item) => typeof item !== 'string' || item.length === 0,
          ) ||
          propertyNameNormalization !==
            'nfkc-lowercase-strip-mark-punctuation-separator-format')
      ) {
        throw new TypeError(`${name}.${wire}: unsupported property policy`);
      }
      const type = nullable.nullable
        ? isRequired
          ? `${base}?`
          : `Presence<${base}>`
        : `${base}${isRequired ? '' : '?'}`;
      return {
        wire,
        member: escapedMember(wire),
        type,
        required: isRequired,
        nullable: nullable.nullable,
        base,
        constant: property.const,
        pattern:
          typeof property.pattern === 'string' ? property.pattern : undefined,
        forbiddenPropertyNames:
          forbiddenPropertyNames === undefined
            ? undefined
            : (forbiddenPropertyNames as string[]),
      };
    });
    const actualMembers = new Set(
      entries.map((entry) => entry.member.replaceAll('`', '')),
    );
    for (const entry of entries) {
      const member = entry.member.replaceAll('`', '');
      if (entry.nullable && entry.required && actualMembers.has(`_${member}`)) {
        throw new TypeError(
          `${name}: member backing collision for ${entry.wire}`,
        );
      }
    }
    if (entries.length === 0) {
      return [
        `public struct ${name}: Codable, Sendable {`,
        '  public init(from decoder: Decoder) throws {',
        '    try rejectUnknownKeys(decoder, allowed: [])',
        '  }',
        '  public func encode(to encoder: Encoder) throws {',
        '    let container = encoder.container(keyedBy: AnyCodingKey.self)',
        '    _ = container',
        '  }',
        '}',
      ].join('\n');
    }
    const codingKeys = entries.map(
      ({ wire, member }) =>
        `    case ${member}${member.replaceAll('`', '') === wire ? '' : ` = ${swiftString(wire)}`}`,
    );
    const decoding = entries.map((entry) => {
      const key = entry.member;
      if (entry.nullable && entry.required)
        return `    self._${entry.member.replaceAll('`', '')} = try container.decode(RequiredNullable<${entry.base}>.self, forKey: .${key})`;
      if (entry.nullable)
        return `    self.${entry.member} = container.contains(.${key}) ? (try container.decodeNil(forKey: .${key}) ? .null : .value(container.decode(${entry.base}.self, forKey: .${key}))) : .absent`;
      if (!entry.required)
        return `    if container.contains(.${key}) {
      guard try !container.decodeNil(forKey: .${key}) else { throw DecodingError.valueNotFound(${entry.base}.self, .init(codingPath: decoder.codingPath, debugDescription: "Present optional key ${entry.wire} cannot be null")) }
      self.${entry.member} = try container.decode(${entry.base}.self, forKey: .${key})
    } else {
      self.${entry.member} = nil
    }`;
      return `    self.${entry.member} = try container.${entry.required ? 'decode' : 'decodeIfPresent'}(${entry.base}.self, forKey: .${key})`;
    });
    const encoding = entries.map((entry) => {
      const key = entry.member;
      if (entry.nullable && !entry.required)
        return `    switch self.${entry.member} {
    case .absent: break
    case .null: try container.encodeNil(forKey: .${key})
    case .value(let value): try container.encode(value, forKey: .${key})
    }`;
      if (entry.nullable)
        return `    try container.encode(self._${entry.member.replaceAll('`', '')}, forKey: .${key})`;
      if (!entry.required)
        return `    try container.encodeIfPresent(self.${entry.member}, forKey: .${key})`;
      return `    try container.encode(self.${entry.member}, forKey: .${key})`;
    });
    const needsCustomEncoding = entries.some(
      (entry) => entry.nullable && !entry.required,
    );
    const constantChecks = entries.flatMap((entry) => {
      const literal =
        typeof entry.constant === 'string'
          ? swiftString(entry.constant)
          : typeof entry.constant === 'boolean' ||
              (typeof entry.constant === 'number' &&
                Number.isFinite(entry.constant))
            ? String(entry.constant)
            : undefined;
      return literal === undefined
        ? []
        : [
            `    guard self.${entry.member} == ${literal} else { throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Invalid literal for ${entry.wire}")) }`,
          ];
    });
    const patternChecks = entries.flatMap((entry) => {
      if (
        entry.pattern === undefined ||
        entry.base !== 'String' ||
        entry.nullable
      )
        return [];
      const pattern = swiftRegularExpression(entry.pattern);
      const check = `value.range(of: ${swiftString(pattern)}, options: .regularExpression) != nil`;
      return entry.required
        ? [
            `    guard self.${entry.member}.range(of: ${swiftString(pattern)}, options: .regularExpression) != nil else { throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "String does not match pattern for ${entry.wire}")) }`,
          ]
        : [
            `    if let value = self.${entry.member} { guard ${check} else { throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "String does not match pattern for ${entry.wire}")) } }`,
          ];
    });
    const propertyPolicyChecks = entries.flatMap((entry) => {
      if (entry.forbiddenPropertyNames === undefined) return [];
      const forbidden = `Set([${entry.forbiddenPropertyNames.map(swiftString).join(', ')}])`;
      if (entry.nullable && !entry.required) {
        return [
          `    if case .value(let value) = self.${entry.member} { try rejectForbiddenPropertyNames(try encodeJSONValue(value), forbidden: ${forbidden}) }`,
        ];
      }
      if (!entry.required || entry.nullable) {
        return [
          `    if let value = self.${entry.member} { try rejectForbiddenPropertyNames(try encodeJSONValue(value), forbidden: ${forbidden}) }`,
        ];
      }
      return [
        `    try rejectForbiddenPropertyNames(try encodeJSONValue(self.${entry.member}), forbidden: ${forbidden})`,
      ];
    });
    return [
      `public struct ${name}: Codable, Sendable {`,
      ...entries.map((entry) =>
        entry.nullable && entry.required
          ? `  @RequiredNullable public var ${entry.member}: ${entry.base}?`
          : `  public let ${entry.member}: ${entry.type}`,
      ),
      '',
      '  private enum CodingKeys: String, CodingKey, CaseIterable {',
      ...codingKeys,
      '  }',
      '',
      '  public init(from decoder: Decoder) throws {',
      '    try rejectUnknownKeys(decoder, allowed: Set(CodingKeys.allCases.map(\\.rawValue)))',
      '    let container = try decoder.container(keyedBy: CodingKeys.self)',
      ...decoding,
      ...constantChecks,
      ...patternChecks,
      ...propertyPolicyChecks,
      '  }',
      ...(needsCustomEncoding
        ? [
            '',
            '  public func encode(to encoder: Encoder) throws {',
            '    var container = encoder.container(keyedBy: CodingKeys.self)',
            ...encoding,
            '  }',
          ]
        : []),
      '}',
    ].join('\n');
  }

  #flattenUnion(schema: JsonSchemaObject): JsonSchemaObject[] {
    const variants = objectArray(schema.oneOf) ?? objectArray(schema.anyOf);
    if (variants === undefined) return [schema];
    return variants.flatMap((variant) => {
      const nested = objectArray(variant.oneOf) ?? objectArray(variant.anyOf);
      return nested === undefined ? [variant] : this.#flattenUnion(variant);
    });
  }

  #discriminator(variants: JsonSchemaObject[]): string | undefined {
    for (const key of [
      'kind',
      'outcome',
      'durability',
      'lifecycle',
      'status',
    ]) {
      if (
        variants.some((variant) => {
          const property = objectValue(objectValue(variant.properties)?.[key]);
          return typeof property?.const === 'string';
        })
      )
        return key;
    }
    return undefined;
  }

  #isUnknownEventVariant(
    variant: JsonSchemaObject,
    discriminator: string | undefined,
  ): boolean {
    if (
      discriminator !== 'kind' ||
      variant.type !== 'object' ||
      variant.additionalProperties !== false
    )
      return false;
    const properties = objectValue(variant.properties);
    const required = new Set(
      Array.isArray(variant.required)
        ? variant.required.filter(
            (item): item is string => typeof item === 'string',
          )
        : [],
    );
    const kind = objectValue(properties?.kind);
    const durability = objectValue(properties?.durability);
    const critical = objectValue(properties?.critical);
    return (
      typeof kind?.pattern === 'string' &&
      (durability?.const === 'durable' || durability?.const === 'transient') &&
      critical?.type === 'boolean' &&
      objectValue(properties?.payload) !== undefined &&
      ['kind', 'durability', 'critical', 'payload'].every((key) =>
        required.has(key),
      )
    );
  }

  #union(name: string, schema: JsonSchemaObject): string {
    const variants = this.#flattenUnion(schema).filter(
      (variant) => variant.type !== 'null',
    );
    const discriminator = this.#discriminator(variants);
    const cases: Array<{
      member: string;
      type: string;
      literal?: string;
      fallback: boolean;
    }> = [];
    const used = new Set<string>();
    for (const [index, variant] of variants.entries()) {
      const discriminatorSchema =
        discriminator === undefined
          ? undefined
          : objectValue(objectValue(variant.properties)?.[discriminator]);
      const literal =
        typeof discriminatorSchema?.const === 'string'
          ? discriminatorSchema.const
          : undefined;
      const fallback =
        literal === undefined &&
        this.#isUnknownEventVariant(variant, discriminator);
      let bare = fallback
        ? 'unknownEvent'
        : literal === undefined
          ? `variant${index + 1}`
          : bareMemberName(literal);
      if (used.has(bare)) bare = `${bare}${index + 1}`;
      used.add(bare);
      const member = escapedMember(bare);
      const type = this.#type(variant, `${name}${bareTypeName(bare)}`);
      cases.push({ member, type, literal, fallback });
    }
    const defaultCandidates = cases.filter(
      (item) => item.literal === undefined,
    );
    const byLiteral = new Map<string, typeof cases>();
    for (const item of cases) {
      if (item.literal === undefined) continue;
      const matching = byLiteral.get(item.literal) ?? [];
      matching.push(item);
      byLiteral.set(item.literal, matching);
    }
    const switchLines = [...byLiteral.entries()].flatMap(
      ([literal, matching]) => [
        `    case ${swiftString(literal)}:`,
        ...matching
          .slice(0, -1)
          .map(
            (item) =>
              `      if let value = try? decodeJSONValue(${item.type}.self, from: raw) { self = .${item.member}(value); return }`,
          ),
        `      self = .${matching.at(-1)!.member}(try decodeJSONValue(${matching.at(-1)!.type}.self, from: raw))`,
      ],
    );
    const decode =
      discriminator === undefined
        ? [
            '    let raw = try JSONValue(from: decoder)',
            ...cases
              .slice(0, -1)
              .map(
                (item) =>
                  `    if let value = try? decodeJSONValue(${item.type}.self, from: raw) { self = .${item.member}(value); return }`,
              ),
            `    self = .${cases.at(-1)?.member ?? 'unknownEvent'}(try decodeJSONValue(${cases.at(-1)?.type ?? 'JSONValue'}.self, from: raw))`,
          ].join('\n')
        : [
            '    let raw = try JSONValue(from: decoder)',
            `    guard case .object(let object) = raw, case .string(let discriminator) = object[${swiftString(discriminator)}] else {`,
            '      throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Missing union discriminator"))',
            '    }',
            '    switch discriminator {',
            ...switchLines,
            defaultCandidates.length === 0
              ? '    default: throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Unknown union discriminator"))'
              : [
                  '    default:',
                  ...defaultCandidates
                    .slice(0, -1)
                    .map(
                      (item) =>
                        `      if let value = try? decodeJSONValue(${item.type}.self, from: raw) { self = .${item.member}(value); return }`,
                    ),
                  `      self = .${defaultCandidates.at(-1)!.member}(try decodeJSONValue(${defaultCandidates.at(-1)!.type}.self, from: raw))`,
                ].join('\n'),
            '    }',
          ].join('\n');
    return [
      `public enum ${name}: Codable, Sendable {`,
      ...cases.map((item) => `  case ${item.member}(${item.type})`),
      '',
      '  public init(from decoder: Decoder) throws {',
      decode,
      '  }',
      '',
      '  public func encode(to encoder: Encoder) throws {',
      '    switch self {',
      ...cases.map(
        (item) =>
          `    case .${item.member}(let value): try value.encode(to: encoder)`,
      ),
      '    }',
      '  }',
      '}',
    ].join('\n');
  }

  #never(name: string): string {
    return `public enum ${name}: Codable, Sendable {\n  public init(from decoder: Decoder) throws {\n    throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "No value satisfies this schema"))\n  }\n  public func encode(to encoder: Encoder) throws { switch self {} }\n}`;
  }
}

export const createSwiftContracts = (ir: JsonSchemaIr): string =>
  new SwiftEmitter(ir.$defs).emit();
