/// <reference types="node" />

import {
  lstatSync,
  readdirSync,
  realpathSync,
  type BigIntStats,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';

import { parseThreadStreamFrame } from '../../src/events.js';
import { contractRegistry } from '../../src/registry.js';
import {
  fixtureManifestSchema,
  isWithin,
  resolveFixtureSchema,
  validateManifestPaths,
  type FixtureManifestEntry,
} from './fixture-manifest.js';
import {
  inspectSecureCatalogFile,
  readSecureCatalogFile,
  sameCatalogFileFingerprint,
  type CatalogFileFingerprint,
} from './secure-catalog-read.js';
import {
  compareConformanceIds,
  type ConformanceRecord,
} from './conformance-jsonl.js';

type Outcome = NonNullable<FixtureManifestEntry['expectedOutcome']>;
const MAX_CATALOG_DIRECTORY_ENTRIES = 1_024;
const MAX_CATALOG_BYTES = 16n * 1024n * 1024n;

export type ConformanceReport = Readonly<{
  fixtureCount: number;
  outcomes: Readonly<Record<Outcome, number>>;
  preservedCursors: readonly string[];
  records: readonly ConformanceRecord[];
}>;

export type ConformanceTestHooks = Readonly<{
  afterFilePathCheck?: (
    context: Readonly<{
      kind: 'fixture' | 'manifest';
      path: string;
    }>,
  ) => void;
  afterFileRead?: (
    context: Readonly<{
      kind: 'fixture' | 'manifest';
      path: string;
    }>,
  ) => void;
  afterFixtureRead?: (context: Readonly<{ id: string; path: string }>) => void;
  afterDirectoryRead?: (
    context: Readonly<{
      directory: string;
      names: readonly string[];
    }>,
  ) => void;
}>;

const catalogRoot = (goldenRoot: string): string => {
  let metadata;
  try {
    metadata = lstatSync(goldenRoot);
  } catch {
    throw new TypeError('conformance catalog root is unavailable');
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new TypeError('conformance catalog root must be a real directory');
  }
  return realpathSync(goldenRoot);
};

type DirectoryIdentity = Readonly<{
  canonicalPath: string;
  dev: bigint;
  ino: bigint;
  mode: bigint;
}>;

const directoryIdentity = (path: string): DirectoryIdentity => {
  const metadata = lstatSync(path, { bigint: true });
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new TypeError('invalid catalog directory');
  }
  return Object.freeze({
    canonicalPath: realpathSync(path),
    dev: metadata.dev,
    ino: metadata.ino,
    mode: metadata.mode,
  });
};

const sameDirectoryIdentity = (
  left: DirectoryIdentity,
  right: DirectoryIdentity,
): boolean =>
  left.canonicalPath === right.canonicalPath &&
  left.dev === right.dev &&
  left.ino === right.ino &&
  left.mode === right.mode;

type ManifestSnapshot = Readonly<{
  fingerprint: CatalogFileFingerprint;
  manifest: readonly FixtureManifestEntry[];
  source: string;
}>;

const readManifestSnapshot = (
  root: string,
  hooks: ConformanceTestHooks,
  expectedFingerprint?: CatalogFileFingerprint,
): ManifestSnapshot => {
  const path = join(root, 'manifest.json');
  const read = readSecureCatalogFile(
    root,
    path,
    {
      afterPathCheck: (candidate) =>
        hooks.afterFilePathCheck?.({ kind: 'manifest', path: candidate }),
      afterRead: (candidate) =>
        hooks.afterFileRead?.({ kind: 'manifest', path: candidate }),
    },
    expectedFingerprint,
  );
  return Object.freeze({
    fingerprint: read.fingerprint,
    manifest: fixtureManifestSchema.parse(JSON.parse(read.source)),
    source: read.source,
  });
};

export const loadConformanceManifest = (
  goldenRoot: string,
  hooks: ConformanceTestHooks = {},
): readonly FixtureManifestEntry[] => {
  const root = catalogRoot(goldenRoot);
  try {
    const { manifest } = readManifestSnapshot(root, hooks);
    try {
      validateManifestPaths(manifest, root);
    } catch (error) {
      if (String(error).toLowerCase().includes('symlink')) {
        throw new TypeError('fixture path uses a symlink');
      }
      throw new TypeError('fixture path validation failed');
    }
    return manifest;
  } catch (error) {
    if (
      error instanceof TypeError &&
      (error.message === 'fixture path uses a symlink' ||
        error.message === 'fixture path validation failed')
    ) {
      throw error;
    }
    throw new TypeError('conformance manifest is malformed');
  }
};

const sameFile = (left: BigIntStats, right: BigIntStats): boolean =>
  left.dev === right.dev && left.ino === right.ino;

const catalogFixtureFiles = (
  root: string,
  hooks: ConformanceTestHooks,
): ReadonlyMap<string, CatalogFileFingerprint> => {
  const files = new Map<string, CatalogFileFingerprint>();
  for (const category of ['valid', 'invalid']) {
    const directory = join(root, category);
    let children: string[];
    try {
      const metadata = lstatSync(directory, { bigint: true });
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw new TypeError('invalid fixture directory');
      }
      const canonicalDirectory = realpathSync(directory);
      if (!isWithin(root, canonicalDirectory)) {
        throw new TypeError('invalid fixture directory');
      }
      children = readdirSync(directory);
      if (children.length > MAX_CATALOG_DIRECTORY_ENTRIES) {
        throw new TypeError('fixture directory has too many entries');
      }
      hooks.afterDirectoryRead?.({ directory, names: Object.freeze(children) });
      for (const name of children) {
        const currentDirectory = lstatSync(directory, { bigint: true });
        if (
          !currentDirectory.isDirectory() ||
          currentDirectory.isSymbolicLink() ||
          !sameFile(metadata, currentDirectory) ||
          realpathSync(directory) !== canonicalDirectory
        ) {
          throw new TypeError('invalid fixture directory');
        }
        const path = join(directory, name);
        files.set(`${category}/${name}`, inspectSecureCatalogFile(root, path));
      }
      const after = lstatSync(directory, { bigint: true });
      if (
        !sameFile(metadata, after) ||
        realpathSync(directory) !== canonicalDirectory
      ) {
        throw new TypeError('invalid fixture directory');
      }
    } catch {
      throw new TypeError('invalid fixture tree');
    }
  }
  return files;
};

const catalogRootManifestFingerprint = (
  root: string,
  hooks: ConformanceTestHooks,
): CatalogFileFingerprint => {
  try {
    const names = readdirSync(root).sort();
    hooks.afterDirectoryRead?.({
      directory: root,
      names: Object.freeze(names),
    });
    if (
      names.length !== 3 ||
      names[0] !== 'invalid' ||
      names[1] !== 'manifest.json' ||
      names[2] !== 'valid'
    ) {
      throw new TypeError('unexpected catalog root entry');
    }
    for (const directory of ['valid', 'invalid']) {
      const metadata = lstatSync(join(root, directory), { bigint: true });
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw new TypeError('invalid catalog root entry');
      }
    }
    return inspectSecureCatalogFile(root, join(root, 'manifest.json'));
  } catch {
    throw new TypeError('invalid conformance catalog');
  }
};

const sameInventory = (
  left: ReadonlyMap<string, CatalogFileFingerprint>,
  right: ReadonlyMap<string, CatalogFileFingerprint>,
): boolean => {
  if (left.size !== right.size) return false;
  for (const [path, fingerprint] of left) {
    const candidate = right.get(path);
    if (
      candidate === undefined ||
      !sameCatalogFileFingerprint(fingerprint, candidate)
    ) {
      return false;
    }
  }
  return true;
};

type UnionDiscriminator = Readonly<{
  name: string;
  values: readonly string[];
}>;

const unionDiscriminator = (
  schema: z.ZodType,
): UnionDiscriminator | undefined => {
  if (!(schema instanceof z.ZodDiscriminatedUnion)) return undefined;
  const options = schema.options;
  if (options.length === 0) {
    throw new TypeError('unsupported registry discriminated union');
  }
  const objects = options.map((option) => {
    if (!(option instanceof z.ZodObject)) {
      throw new TypeError('unsupported registry discriminated union');
    }
    return option;
  });
  const candidates = Object.keys(objects[0]!.shape)
    .map((name) => {
      const values = objects.map((option) => {
        const member = option.shape[name];
        return member instanceof z.ZodLiteral ? member.value : undefined;
      });
      return values.every(
        (value): value is string => typeof value === 'string',
      ) && new Set(values).size === values.length
        ? Object.freeze({ name, values: Object.freeze(values) })
        : undefined;
    })
    .filter(
      (candidate): candidate is UnionDiscriminator => candidate !== undefined,
    );
  if (candidates.length !== 1) {
    throw new TypeError('unsupported registry discriminated union');
  }
  return candidates[0];
};

type Requirement = Readonly<{
  discriminator?: string;
  expectedExpect: FixtureManifestEntry['expect'];
  expectedValue?: string;
  id: string;
  schema: string;
}>;

type FixedDescriptor = Readonly<{
  expectedExpect: FixtureManifestEntry['expect'];
  predicate: (value: unknown) => boolean;
  schema: string;
}>;

const fixedDescriptors: Readonly<Record<string, FixedDescriptor>> = {
  'optional.absent': {
    expectedExpect: 'accept',
    predicate: (value) =>
      objectKeysEqual(value, []) && !hasOwn(value, 'cursor'),
    schema: 'schema:PaginationQuery',
  },
  'nullable.null': {
    expectedExpect: 'accept',
    predicate: (value) => value === null,
    schema: 'schema:JsonValue',
  },
  'optional-nullable.absent': {
    expectedExpect: 'accept',
    predicate: (value) =>
      objectKeysEqual(value, ['model']) &&
      nestedValue(value, 'model') === 'fixture',
    schema: 'schema:ConfigPatch',
  },
  'optional-nullable.null': {
    expectedExpect: 'accept',
    predicate: (value) =>
      objectKeysEqual(value, ['providerCredentialRef']) &&
      nestedValue(value, 'providerCredentialRef') === null,
    schema: 'schema:ConfigPatch',
  },
  'optional-nullable.value': {
    expectedExpect: 'accept',
    predicate: (value) =>
      objectKeysEqual(value, ['providerCredentialRef']) &&
      nestedValue(value, 'providerCredentialRef') === 'credential-ref-1',
    schema: 'schema:ConfigPatch',
  },
  'command-ack.original': {
    expectedExpect: 'accept',
    predicate: (value) => commandAckMatches(value, false),
    schema: 'schema:CommandAck',
  },
  'command-ack.replayed': {
    expectedExpect: 'accept',
    predicate: (value) => commandAckMatches(value, true),
    schema: 'schema:CommandAck',
  },
  'snapshot-reset.without-runtime': {
    expectedExpect: 'accept',
    predicate: (value) => snapshotRuntimeMatches(value, false),
    schema: 'schema:SnapshotReset',
  },
  'snapshot-reset.with-runtime': {
    expectedExpect: 'accept',
    predicate: (value) => snapshotRuntimeMatches(value, true),
    schema: 'schema:SnapshotReset',
  },
  'credential-ref': {
    expectedExpect: 'accept',
    predicate: (value) =>
      objectKeysEqual(value, [
        'createdAt',
        'credentialRef',
        'label',
        'provider',
      ]) &&
      nestedValue(value, 'credentialRef') === 'credential-ref-1' &&
      nestedValue(value, 'provider') === 'fixture-provider' &&
      nestedValue(value, 'label') === 'Fixture credential' &&
      nestedValue(value, 'createdAt') === '2026-07-17T10:00:00+08:00',
    schema: 'schema:CredentialRef',
  },
  'reject.nested-secret': {
    expectedExpect: 'reject',
    predicate: nestedSecretFixture,
    schema: 'schema:ConfigPatch',
  },
  'reject.unknown-top-level': {
    expectedExpect: 'reject',
    predicate: (value) =>
      objectKeysEqual(value, ['status', 'unknown']) &&
      nestedValue(value, 'status') === 'ok' &&
      nestedValue(value, 'unknown') === true,
    schema: 'schema:HealthResponse',
  },
  'reject.unknown-nested': {
    expectedExpect: 'reject',
    predicate: (value) =>
      objectKeysEqual(value, ['error']) &&
      objectKeysEqual(nestedValue(value, 'error'), [
        'code',
        'message',
        'retryable',
        'unknown',
      ]) &&
      nestedValue(value, 'error', 'code') === 'VALIDATION_ERROR' &&
      nestedValue(value, 'error', 'unknown') === true,
    schema: 'schema:ApiError',
  },
  'cursor.above-safe-integer': {
    expectedExpect: 'accept',
    predicate: (value) => value === '9007199254740993',
    schema: 'schema:DurableCursor',
  },
  'unknown.durable.non-critical': {
    expectedExpect: 'accept',
    predicate: (value) => unknownEventMatches(value, 'durable', false),
    schema: 'schema:ThreadStreamFrame',
  },
  'unknown.transient.non-critical': {
    expectedExpect: 'accept',
    predicate: (value) => unknownEventMatches(value, 'transient', false),
    schema: 'schema:ThreadStreamFrame',
  },
  'unknown.critical': {
    expectedExpect: 'accept',
    predicate: (value) => unknownEventMatches(value, 'durable', true),
    schema: 'schema:ThreadStreamFrame',
  },
  'known-event.malformed.protocol-error': {
    expectedExpect: 'reject',
    predicate: malformedKnownEventMatches,
    schema: 'schema:ThreadStreamFrame',
  },
};

const fixedRequirements: readonly Requirement[] = Object.entries(
  fixedDescriptors,
).map(([id, descriptor]) => ({
  expectedExpect: descriptor.expectedExpect,
  id,
  schema: descriptor.schema,
}));

const requiredCoverage = (): readonly Requirement[] => {
  const requirements = [...fixedRequirements];
  for (const [name, schema] of Object.entries(contractRegistry.schemas)) {
    if (schema instanceof z.ZodEnum) {
      for (const value of schema.options) {
        if (typeof value !== 'string')
          throw new TypeError('unsupported registry enum');
        requirements.push({
          expectedExpect: 'accept',
          expectedValue: value,
          id: `enum.${name}.${value}`,
          schema: `schema:${name}`,
        });
      }
    }
    const discriminator = unionDiscriminator(schema);
    if (discriminator !== undefined) {
      for (const value of discriminator.values) {
        requirements.push({
          discriminator: discriminator.name,
          expectedExpect: 'accept',
          expectedValue: value,
          id: `union.${name}.${value}`,
          schema: `schema:${name}`,
        });
      }
    }
  }
  const errorSchema = contractRegistry.schemas.ErrorCode;
  if (!(errorSchema instanceof z.ZodEnum)) {
    throw new TypeError('unsupported ErrorCode registry enum');
  }
  for (const code of errorSchema.options) {
    if (typeof code !== 'string')
      throw new TypeError('unsupported ErrorCode registry enum');
    requirements.push({
      expectedExpect: 'accept',
      expectedValue: code,
      id: `api-error.${code}`,
      schema: 'schema:ApiError',
    });
  }
  return requirements;
};

const assertRequiredCoverage = (
  manifest: readonly FixtureManifestEntry[],
  requirements: readonly Requirement[] = requiredCoverage(),
): void => {
  const entries = new Map(manifest.map((entry) => [entry.id, entry]));
  for (const requirement of requirements) {
    const entry = entries.get(requirement.id);
    if (
      entry === undefined ||
      entry.schema !== requirement.schema ||
      entry.expect !== requirement.expectedExpect
    ) {
      throw new TypeError(
        'conformance manifest is missing a required category',
      );
    }
  }
};

const assertRequiredOutcomes = (
  manifest: readonly FixtureManifestEntry[],
): void => {
  const outcomesById: Readonly<Record<string, Outcome>> = {
    'known-event.malformed.protocol-error': 'protocolError',
    'snapshot-reset.with-runtime': 'known',
    'snapshot-reset.without-runtime': 'known',
    'union.UnknownEventEnvelope.durable': 'unknownNonCritical',
    'union.UnknownEventEnvelope.transient': 'unknownNonCritical',
    'unknown.critical': 'resetRequired',
    'unknown.durable.non-critical': 'unknownNonCritical',
    'unknown.transient.non-critical': 'unknownNonCritical',
  };
  for (const entry of manifest) {
    const required =
      outcomesById[entry.id] ??
      (entry.schema === 'schema:KnownDurableEventEnvelope' ||
      entry.schema === 'schema:KnownTransientEventEnvelope'
        ? 'known'
        : undefined);
    if (required !== undefined && entry.expectedOutcome !== required) {
      throw new TypeError('conformance manifest is missing a required outcome');
    }
  }
};

const objectValue = (value: unknown): object | undefined =>
  value !== null && typeof value === 'object' ? value : undefined;

const hasOwn = (value: unknown, key: string): boolean => {
  const object = objectValue(value);
  return object !== undefined && Object.hasOwn(object, key);
};

const objectKeysEqual = (
  value: unknown,
  expected: readonly string[],
): boolean => {
  const object = objectValue(value);
  if (object === undefined || Array.isArray(object)) return false;
  const actual = Object.keys(object).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    sortedExpected.every((key, index) => actual[index] === key)
  );
};

const nestedValue = (value: unknown, ...keys: readonly string[]): unknown => {
  let cursor = objectValue(value);
  for (const [index, key] of keys.entries()) {
    if (cursor === undefined) return undefined;
    const next = Reflect.get(cursor, key);
    if (index === keys.length - 1) return next;
    cursor = objectValue(next);
  }
  return undefined;
};

function commandAckMatches(value: unknown, replayed: boolean): boolean {
  return (
    objectKeysEqual(value, [
      'acceptedAt',
      'commandId',
      'currentDurableCursor',
      'replayed',
      'status',
      'threadId',
    ]) &&
    nestedValue(value, 'commandId') === 'command-1' &&
    nestedValue(value, 'currentDurableCursor') === '41' &&
    nestedValue(value, 'replayed') === replayed &&
    nestedValue(value, 'status') === 'accepted' &&
    nestedValue(value, 'threadId') === 'thread-1'
  );
}

function snapshotRuntimeMatches(value: unknown, withRuntime: boolean): boolean {
  const snapshot = nestedValue(value, 'snapshot');
  const frameRuntime =
    hasOwn(value, 'incarnationId') && hasOwn(value, 'streamCursor');
  const snapshotRuntime =
    hasOwn(snapshot, 'incarnationId') &&
    hasOwn(snapshot, 'streamCursor') &&
    hasOwn(snapshot, 'streamState');
  return (
    nestedValue(value, 'kind') === 'stream.snapshotReset' &&
    nestedValue(value, 'durableCursor') === '41' &&
    nestedValue(snapshot, 'durableCursor') === '41' &&
    frameRuntime === withRuntime &&
    snapshotRuntime === withRuntime &&
    (withRuntime
      ? nestedValue(value, 'incarnationId') === 'incarnation-1' &&
        nestedValue(value, 'streamCursor') === '43' &&
        nestedValue(snapshot, 'incarnationId') === 'incarnation-1' &&
        nestedValue(snapshot, 'streamCursor') === '43'
      : true)
  );
}

function nestedSecretFixture(value: unknown): boolean {
  const nested = nestedValue(value, 'providerOptions', 'nested');
  if (!Array.isArray(nested) || nested.length !== 1) return false;
  return (
    objectKeysEqual(value, ['providerOptions']) &&
    objectKeysEqual(nested[0], ['secret']) &&
    nestedValue(nested[0], 'secret') === 'not-a-secret-value'
  );
}

function unknownEventMatches(
  value: unknown,
  durability: 'durable' | 'transient',
  critical: boolean,
): boolean {
  if (
    nestedValue(value, 'durability') !== durability ||
    nestedValue(value, 'critical') !== critical
  ) {
    return false;
  }
  if (durability === 'durable') {
    return (
      nestedValue(value, 'kind') === 'plugin.futureDurable' &&
      nestedValue(value, 'durableSequence') === '9007199254740993' &&
      !hasOwn(value, 'streamSequence') &&
      !hasOwn(value, 'durableBasis') &&
      nestedValue(value, 'payload', 'future') === true
    );
  }
  const payload = nestedValue(value, 'payload');
  return (
    nestedValue(value, 'kind') === 'plugin.futureTransient' &&
    nestedValue(value, 'streamSequence') === '9007199254740994' &&
    nestedValue(value, 'durableBasis') === '9007199254740993' &&
    typeof nestedValue(value, 'incarnationId') === 'string' &&
    !hasOwn(value, 'durableSequence') &&
    Array.isArray(payload) &&
    payload.length === 1 &&
    payload[0] === 'future'
  );
}

function malformedKnownEventMatches(value: unknown): boolean {
  return (
    nestedValue(value, 'kind') === 'thread.updated' &&
    nestedValue(value, 'durability') === 'durable' &&
    nestedValue(value, 'critical') === false &&
    nestedValue(value, 'durableSequence') === '42' &&
    objectKeysEqual(nestedValue(value, 'payload'), [])
  );
}

const assertFixtureSemantics = (
  entry: FixtureManifestEntry,
  value: unknown,
  requirements: ReadonlyMap<string, Requirement>,
): void => {
  const requirement = requirements.get(entry.id);
  if (requirement?.expectedValue !== undefined) {
    const actual = entry.id.startsWith('enum.')
      ? value
      : entry.id.startsWith('api-error.')
        ? nestedValue(value, 'error', 'code')
        : requirement.discriminator === undefined
          ? undefined
          : nestedValue(value, requirement.discriminator);
    if (actual !== requirement.expectedValue) {
      throw new TypeError('conformance fixture semantics do not match id');
    }
  }

  const fixed = fixedDescriptors[entry.id];
  if (fixed !== undefined && !fixed.predicate(value)) {
    throw new TypeError('conformance fixture semantics do not match category');
  }
};

const fixtureValue = (
  root: string,
  entry: FixtureManifestEntry,
  hooks: ConformanceTestHooks,
  expectedFingerprint: CatalogFileFingerprint,
): unknown => {
  const path = resolve(root, entry.file);
  try {
    const read = readSecureCatalogFile(
      root,
      path,
      {
        afterPathCheck: (candidate) =>
          hooks.afterFilePathCheck?.({ kind: 'fixture', path: candidate }),
        afterRead: (candidate) =>
          hooks.afterFileRead?.({ kind: 'fixture', path: candidate }),
      },
      expectedFingerprint,
    );
    const value: unknown = JSON.parse(read.source);
    hooks.afterFixtureRead?.({ id: entry.id, path });
    return value;
  } catch {
    throw new TypeError('conformance fixture JSON is malformed or unavailable');
  }
};

const cursorFields = [
  'durableSequence',
  'streamSequence',
  'durableBasis',
] as const;

export const runConformanceCatalog = (
  goldenRoot: string,
  hooks: ConformanceTestHooks = {},
): ConformanceReport => {
  const root = catalogRoot(goldenRoot);
  let rootIdentity: DirectoryIdentity;
  let manifestFingerprint: CatalogFileFingerprint;
  try {
    rootIdentity = directoryIdentity(root);
    if (rootIdentity.canonicalPath !== root) {
      throw new TypeError('catalog root identity mismatch');
    }
    manifestFingerprint = catalogRootManifestFingerprint(root, hooks);
  } catch {
    throw new TypeError('invalid conformance catalog');
  }
  const fixtureFiles = catalogFixtureFiles(root, hooks);
  let manifestSnapshot: ManifestSnapshot;
  try {
    manifestSnapshot = readManifestSnapshot(root, hooks, manifestFingerprint);
  } catch {
    throw new TypeError('conformance manifest is malformed');
  }
  const catalogBytes = [...fixtureFiles.values()].reduce(
    (total, fingerprint) => total + fingerprint.size,
    manifestFingerprint.size,
  );
  if (catalogBytes > MAX_CATALOG_BYTES) {
    throw new TypeError('conformance catalog is too large');
  }
  try {
    validateManifestPaths(manifestSnapshot.manifest, root);
  } catch (error) {
    if (String(error).toLowerCase().includes('symlink')) {
      throw new TypeError('fixture path uses a symlink');
    }
    throw new TypeError('fixture path validation failed');
  }
  const manifest = manifestSnapshot.manifest;
  const referencedFiles = new Set(manifest.map(({ file }) => file));
  for (const file of fixtureFiles.keys()) {
    if (!referencedFiles.has(file)) {
      throw new TypeError('conformance catalog contains an orphan fixture');
    }
  }
  const schemas = new Map<FixtureManifestEntry, z.ZodType>();
  for (const entry of manifest) {
    try {
      schemas.set(entry, resolveFixtureSchema(entry.schema));
    } catch {
      throw new TypeError('conformance manifest has an unknown schema target');
    }
  }
  const requirements = requiredCoverage();
  assertRequiredCoverage(manifest, requirements);
  assertRequiredOutcomes(manifest);
  const requirementsById = new Map(
    requirements.map((requirement) => [requirement.id, requirement]),
  );

  const outcomes: Record<Outcome, number> = {
    known: 0,
    unknownNonCritical: 0,
    resetRequired: 0,
    protocolError: 0,
  };
  const preservedCursors: string[] = [];
  const records: ConformanceRecord[] = [];
  for (const entry of manifest) {
    const schema = schemas.get(entry)!;
    const expectedFingerprint = fixtureFiles.get(entry.file);
    if (expectedFingerprint === undefined) {
      throw new TypeError('conformance catalog changed during run');
    }
    const value = fixtureValue(root, entry, hooks, expectedFingerprint);
    if (
      entry.id === 'cursor.above-safe-integer' &&
      value !== '9007199254740993'
    ) {
      throw new TypeError(
        'conformance 64-bit cursor fixture changed value or type',
      );
    }
    const actual = schema.safeParse(value).success ? 'accept' : 'reject';
    if (actual !== entry.expect) {
      throw new TypeError('conformance fixture expectation mismatch');
    }
    let recordOutcome: ConformanceRecord['outcome'] = actual;
    if (entry.expectedOutcome !== undefined) {
      const parsed = parseThreadStreamFrame(value);
      if (parsed.outcome !== entry.expectedOutcome) {
        throw new TypeError('conformance parser outcome mismatch');
      }
      outcomes[entry.expectedOutcome] += 1;
      if (parsed.outcome === 'unknownNonCritical') {
        for (const field of cursorFields) {
          const inputCursor =
            value !== null && typeof value === 'object'
              ? Reflect.get(value, field)
              : undefined;
          const parsedCursor = Reflect.get(parsed.frame, field);
          if (inputCursor !== undefined) {
            if (
              typeof inputCursor !== 'string' ||
              parsedCursor !== inputCursor
            ) {
              throw new TypeError(
                'unknown event frame cursor was not preserved',
              );
            }
            preservedCursors.push(inputCursor);
          }
        }
      }
      recordOutcome = parsed.outcome;
    }
    assertFixtureSemantics(entry, value, requirementsById);
    records.push(Object.freeze({ id: entry.id, outcome: recordOutcome }));
  }
  try {
    const finalManifest = readManifestSnapshot(
      root,
      hooks,
      manifestSnapshot.fingerprint,
    );
    const finalManifestFingerprint = catalogRootManifestFingerprint(
      root,
      hooks,
    );
    const finalInventory = catalogFixtureFiles(root, hooks);
    const finalRootIdentity = directoryIdentity(root);
    if (
      finalManifest.source !== manifestSnapshot.source ||
      !sameCatalogFileFingerprint(
        finalManifestFingerprint,
        manifestSnapshot.fingerprint,
      ) ||
      !sameInventory(fixtureFiles, finalInventory) ||
      !sameDirectoryIdentity(rootIdentity, finalRootIdentity)
    ) {
      throw new TypeError('catalog snapshot mismatch');
    }
  } catch {
    throw new TypeError('conformance catalog changed during run');
  }
  return Object.freeze({
    fixtureCount: manifest.length,
    outcomes: Object.freeze(outcomes),
    preservedCursors: Object.freeze(preservedCursors),
    records: Object.freeze(
      records.sort((left, right) => compareConformanceIds(left.id, right.id)),
    ),
  });
};
