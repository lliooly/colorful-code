import { z } from 'zod';

import {
  createDurableEventEnvelopeSchema,
  createEventPayloadSchema,
  createTransientEventEnvelopeSchema,
} from '@colorful-code/schema/events';

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <Value>() =>
    Value extends Right ? 1 : 2
    ? true
    : false;
type Expect<Value extends true> = Value;

const payload = createEventPayloadSchema(
  'example.created',
  z.strictObject({ value: z.string() }),
);
const durable = createDurableEventEnvelopeSchema(payload);
const transient = createTransientEventEnvelopeSchema(payload);

export type DurableKindIsLiteral = Expect<
  Equal<z.output<typeof durable>['kind'], 'example.created'>
>;
export type DurablePayloadIsConcrete = Expect<
  Equal<z.output<typeof durable>['payload'], { value: string }>
>;
export type TransientKindIsLiteral = Expect<
  Equal<z.output<typeof transient>['kind'], 'example.created'>
>;
export type TransientPayloadIsConcrete = Expect<
  Equal<z.output<typeof transient>['payload'], { value: string }>
>;
