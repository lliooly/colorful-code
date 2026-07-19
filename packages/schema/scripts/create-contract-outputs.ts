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

export const validateContractOutputs = (outputs: ContractOutputs): void => {
  JSON.parse(outputs['generated/openapi.v2.json']);
  JSON.parse(outputs['generated/events.schema.json']);
  if (
    !outputs['generated/typescript/contracts.ts'].startsWith(
      '// This file is generated.',
    )
  ) {
    throw new Error('generated TypeScript artifact failed validation');
  }
  if (
    !outputs[
      'swift-fixture/Sources/ColorfulCodeContracts/ColorfulCodeContracts.swift'
    ].startsWith('// This file is generated.')
  ) {
    throw new Error('generated Swift artifact failed validation');
  }
};

export const createContractOutputs = (): ContractOutputs => {
  const ir = createJsonSchemaIr(contractRegistry.schemas);
  const outputs = Object.freeze({
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
  validateContractOutputs(outputs);
  return outputs;
};
