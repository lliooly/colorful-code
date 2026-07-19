import { contractRegistry, type ContractRegistry } from '../../src/registry.js';
import { createJsonSchemaIr } from './json-schema.js';

const EVENTS_TITLE = 'Colorful Code Thread Stream Events';
const CONTRACT_VERSION = '0.0.0';

const freezeJson = <Value>(value: Value): Value => {
  if (value === null || typeof value !== 'object') return value;
  for (const nested of Object.values(value)) freezeJson(nested);
  return Object.freeze(value);
};

export const createEventsSchema = (
  registry: ContractRegistry = contractRegistry,
) => {
  const ir = createJsonSchemaIr(registry.events);

  return freezeJson({
    $schema: 'https://json-schema.org/draft/2020-12/schema' as const,
    title: EVENTS_TITLE,
    version: CONTRACT_VERSION,
    $ref: '#/$defs/ThreadStreamFrame',
    $defs: ir.$defs,
  });
};
