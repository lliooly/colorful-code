/// <reference types="node" />

import { lstatSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { z } from 'zod';

import { contractRegistry } from '../../src/registry.js';

const expectedOutcomeSchema = z.enum([
  'known',
  'unknownNonCritical',
  'resetRequired',
  'protocolError',
]);

export const fixtureManifestEntrySchema = z.strictObject({
  id: z.string().trim().min(1),
  schema: z.string().trim().min(1),
  file: z.string().trim().min(1),
  expect: z.enum(['accept', 'reject']),
  expectedOutcome: expectedOutcomeSchema.optional(),
});

export const fixtureManifestSchema = z
  .array(fixtureManifestEntrySchema)
  .superRefine((entries, context) => {
    for (const field of ['id', 'file'] as const) {
      const seen = new Set<string>();
      for (const [index, entry] of entries.entries()) {
        if (seen.has(entry[field])) {
          context.addIssue({
            code: 'custom',
            message: `duplicate fixture ${field}`,
            path: [index, field],
          });
        }
        seen.add(entry[field]);
      }
    }
  });

export type FixtureManifestEntry = z.infer<typeof fixtureManifestEntrySchema>;

const invalidTarget = (): never => {
  throw new TypeError('unknown fixture schema target');
};

export const resolveFixtureSchema = (target: string): z.ZodType => {
  if (target.startsWith('schema:')) {
    const name = target.slice('schema:'.length);
    if (!Object.hasOwn(contractRegistry.schemas, name)) return invalidTarget();
    const schema = contractRegistry.schemas[name];
    return schema instanceof z.ZodType ? schema : invalidTarget();
  }
  const match = /^http:([^:]+):result$/.exec(target);
  if (match !== null) {
    const operationId = match[1]!;
    if (!Object.hasOwn(contractRegistry.http, operationId)) {
      return invalidTarget();
    }
    const resultSchema = contractRegistry.http[operationId]?.resultSchema;
    return resultSchema instanceof z.ZodType ? resultSchema : invalidTarget();
  }
  return invalidTarget();
};

export const isWithin = (root: string, candidate: string) => {
  const path = relative(root, candidate);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..');
};

export const validateManifestPaths = (
  input: readonly FixtureManifestEntry[],
  goldenRoot: string,
): void => {
  const manifest = fixtureManifestSchema.parse(input);
  const root = realpathSync(goldenRoot);
  for (const entry of manifest) {
    if (isAbsolute(entry.file) || entry.file.split(/[\\/]/u).includes('..')) {
      throw new TypeError(
        `fixture path must stay within golden root: ${entry.id}`,
      );
    }
    const destination = resolve(root, entry.file);
    if (!isWithin(root, destination)) {
      throw new TypeError(`fixture path escapes golden root: ${entry.id}`);
    }
    let cursor = dirname(destination);
    while (isWithin(root, cursor) && cursor !== root) {
      try {
        if (lstatSync(cursor).isSymbolicLink()) {
          throw new TypeError(`fixture path uses a symlink: ${entry.id}`);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      cursor = dirname(cursor);
    }
    try {
      if (lstatSync(destination).isSymbolicLink()) {
        throw new TypeError(`fixture path uses a symlink: ${entry.id}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
};
