import { z } from 'zod';

type Refinement<Value> = (
  value: Value,
  context: z.core.$RefinementCtx<Value>,
) => void | Promise<void>;
type RefinementFactory = () => z.core.$ZodCheck<unknown>;

const refinementFactories = new WeakMap<object, RefinementFactory>();

export const withClonableSuperRefine = <Schema extends z.ZodType>(
  schema: Schema,
  refinement: Refinement<z.output<Schema>>,
  parameters?: z.core.$ZodSuperRefineParams,
): Schema => {
  const capturedParameters =
    parameters === undefined ? undefined : Object.freeze({ ...parameters });
  // Reconstructing the core check is required because its executable closure
  // captures the definition supplied by z.superRefine.
  const factory = () =>
    z.superRefine(refinement, capturedParameters) as z.core.$ZodCheck<unknown>;
  const check = factory();
  refinementFactories.set(check, factory);
  return schema.check(check as z.core.$ZodCheck<z.output<Schema>>) as Schema;
};

export const cloneRegisteredRefinement = (
  check: object,
): z.core.$ZodCheck<unknown> | undefined => {
  const factory = refinementFactories.get(check);
  if (factory === undefined) return undefined;
  const cloned = factory();
  refinementFactories.set(cloned, factory);
  return cloned;
};
