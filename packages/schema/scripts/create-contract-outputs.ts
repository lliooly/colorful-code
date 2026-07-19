import { contractRegistry } from '../src/registry.js';
import { createEventsSchema } from './lib/events-schema.js';
import { createJsonSchemaIr } from './lib/json-schema.js';
import { createOpenApiDocument } from './lib/openapi.js';
import { stableJson } from './lib/stable-json.js';
import { createSwiftContracts } from './lib/swift.js';
import { createTypeScriptContracts } from './lib/typescript.js';

export const GENERATED_PATHS = [
  'generated/openapi.v2.json',
  'generated/events.schema.json',
  'generated/typescript/contracts.ts',
  'swift-fixture/Sources/ColorfulCodeContracts/ColorfulCodeContracts.swift',
] as const;

export type ContractOutputs = Readonly<
  Record<(typeof GENERATED_PATHS)[number], string>
>;

export const createContractOutputs = (): ContractOutputs => {
  const ir = createJsonSchemaIr(contractRegistry.schemas);
  return Object.freeze({
    'generated/openapi.v2.json': stableJson(
      createOpenApiDocument(contractRegistry),
    ),
    'generated/events.schema.json': stableJson(
      createEventsSchema(contractRegistry),
    ),
    'generated/typescript/contracts.ts': createTypeScriptContracts(
      contractRegistry.schemas,
    ),
    'swift-fixture/Sources/ColorfulCodeContracts/ColorfulCodeContracts.swift':
      createSwiftContracts(ir),
  } satisfies ContractOutputs);
};
