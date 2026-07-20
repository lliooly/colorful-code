import { afterEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { z } from 'zod';

import {
  fixtureManifestSchema,
  generateFixtureCatalog,
  resolveFixtureSchema,
  validateManifestPaths,
} from '../scripts/generate-fixtures.js';
import { withClonableSuperRefine } from '../src/clonable-refinement.js';
import {
  contractRegistry,
  createIsolatedSchemaView,
} from '../src/registry.js';
import { snapshotResetSchema } from '../src/snapshot.js';

const GOLDEN_ROOT = resolve(import.meta.dir, '../fixtures/golden');
const temporaryRoots: string[] = [];
const temporaryRoot = (prefix: string) => {
  const root = mkdtempSync(join(tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
};

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe('golden fixture catalog', () => {
  test('keeps SnapshotReset superRefine checks executable in an isolated view', () => {
    const fixture = JSON.parse(
      readFileSync(
        join(
          GOLDEN_ROOT,
          'valid/snapshot-reset.without-runtime.json',
        ),
        'utf8',
      ),
    );
    const view = createIsolatedSchemaView(snapshotResetSchema);

    expect(view.safeParse(fixture).success).toBe(true);
    expect(
      view.safeParse({ ...fixture, durableCursor: 'different' }).success,
    ).toBe(false);
  });
  test('isolates custom-check abort metadata and subsequent check execution', () => {
    const first = withClonableSuperRefine(
      z.string(),
      (_value, context) => {
        context.addIssue({ code: 'custom', message: 'first' });
      },
    );
    const authoring = withClonableSuperRefine(
      first,
      (_value, context) => {
        context.addIssue({ code: 'custom', message: 'second' });
      },
    );
    const view = createIsolatedSchemaView(authoring);
    const firstCheck = authoring._zod.def.checks![0]!;
    (firstCheck._zod.def as { abort?: boolean }).abort = true;

    const result = view.safeParse('fixture');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map(({ message }) => message)).toEqual([
        'first',
        'second',
      ]);
    }
  });
  test('fails closed for an unregistered custom check', () => {
    expect(() =>
      createIsolatedSchemaView(z.string().superRefine(() => {})),
    ).toThrow(/unregistered custom/i);
  });
  test('publishes a manifest beside the valid and invalid fixture sets', () => {
    expect(existsSync(resolve(GOLDEN_ROOT, 'manifest.json'))).toBe(true);
    expect(existsSync(resolve(GOLDEN_ROOT, 'valid'))).toBe(true);
    expect(existsSync(resolve(GOLDEN_ROOT, 'invalid'))).toBe(true);
  });

  test('accepts only strict manifest entries with a closed expect vocabulary', () => {
    const entry = {
      id: 'health.accept',
      schema: 'schema:HealthResponse',
      file: 'valid/health.accept.json',
      expect: 'accept',
    };
    expect(fixtureManifestSchema.parse([entry])).toEqual([entry]);
    expect(
      fixtureManifestSchema.safeParse([{ ...entry, expect: 'maybe' }]).success,
    ).toBe(false);
    expect(
      fixtureManifestSchema.safeParse([{ ...entry, extra: true }]).success,
    ).toBe(false);
  });

  test('requires unique ids and files and confines paths to a real golden root', () => {
    const root = temporaryRoot('schema-fixture-paths-');
    const outside = temporaryRoot('schema-fixture-outside-');
    symlinkSync(outside, join(root, 'escape'));
    const entry = {
      id: 'one',
      schema: 'schema:HealthResponse',
      file: 'valid/one.json',
      expect: 'accept' as const,
    };
    expect(() => validateManifestPaths([entry, entry], root)).toThrow(/id/i);
    expect(() =>
      validateManifestPaths([entry, { ...entry, id: 'two' }], root),
    ).toThrow(/file/i);
    for (const file of ['../outside.json', '/tmp/outside.json', 'escape/x.json']) {
      expect(() => validateManifestPaths([{ ...entry, file }], root)).toThrow(
        /path|root|symlink/i,
      );
    }
  });

  test('resolves only immutable schema and HTTP registry targets', () => {
    expect(resolveFixtureSchema('schema:HealthResponse')).toBeDefined();
    expect(resolveFixtureSchema('http:thread.delete:result')).toBeDefined();
    for (const target of [
      'HealthResponse',
      'schema:Missing',
      'http:missing:result',
      'http:thread.delete:body',
      'schema:toString',
      'schema:constructor',
      'schema:__proto__',
      'http:toString:result',
    ]) {
      expect(() => resolveFixtureSchema(target)).toThrow(/target/i);
    }
    const sentinel = 'SENTINEL_DO_NOT_DISCLOSE';
    expect(() => resolveFixtureSchema(`schema:${sentinel}`)).toThrow();
    try {
      resolveFixtureSchema(`schema:${sentinel}`);
    } catch (error) {
      expect(String(error)).not.toContain(sentinel);
    }
  });

  test('rejects an existing non-directory golden root', async () => {
    const parent = temporaryRoot('schema-fixture-root-file-');
    const root = join(parent, 'golden');
    writeFileSync(root, 'user data');

    await expect(generateFixtureCatalog(root)).rejects.toThrow(/directory/i);
    expect(readFileSync(root, 'utf8')).toBe('user data');
  });

  test('does not create a missing golden root', async () => {
    const parent = temporaryRoot('schema-fixture-root-missing-');
    const root = join(parent, 'golden');

    await expect(generateFixtureCatalog(root)).rejects.toThrow();
    expect(existsSync(root)).toBe(false);
  });

  test('rejects a symlink golden root', async () => {
    const parent = temporaryRoot('schema-fixture-root-link-');
    const target = temporaryRoot('schema-fixture-root-target-');
    const root = join(parent, 'golden');
    symlinkSync(target, root);

    await expect(generateFixtureCatalog(root)).rejects.toThrow(
      /real directory/i,
    );
    expect(readdirSync(target)).toEqual([]);
  });

  test('rejects unmanaged orphan files without changing the catalog', async () => {
    const root = temporaryRoot('schema-fixture-orphan-');
    await generateFixtureCatalog(root);
    const before = readFileSync(join(root, 'manifest.json'));
    writeFileSync(join(root, 'valid/orphan.json'), 'user data');

    await expect(generateFixtureCatalog(root)).rejects.toThrow(
      /valid\/orphan\.json/,
    );
    expect(readFileSync(join(root, 'manifest.json')).equals(before)).toBe(true);
    expect(readFileSync(join(root, 'valid/orphan.json'), 'utf8')).toBe(
      'user data',
    );
  });

  test('redacts syntax and schema details from malformed prior manifests', async () => {
    const sentinel = 'SENTINEL_DO_NOT_DISCLOSE';
    for (const source of [
      `{"value": ${sentinel}}`,
      JSON.stringify([
        {
          id: 'fixture',
          schema: 'schema:HealthResponse',
          file: 'valid/fixture.json',
          expect: 'accept',
          [sentinel]: true,
        },
      ]),
    ]) {
      const root = temporaryRoot('schema-fixture-malformed-manifest-');
      writeFileSync(join(root, 'manifest.json'), source);

      try {
        await generateFixtureCatalog(root);
        throw new Error('expected malformed manifest rejection');
      } catch (error) {
        expect(String(error)).toContain(
          'golden fixture manifest is malformed',
        );
        expect(String(error)).not.toContain(sentinel);
      }
      expect(readFileSync(join(root, 'manifest.json'), 'utf8')).toBe(source);
      expect(readdirSync(root)).toEqual(['manifest.json']);
    }
  });

  test('serializes concurrent generation on one root without residue', async () => {
    const root = temporaryRoot('schema-fixture-concurrent-');
    await Promise.all([
      generateFixtureCatalog(root),
      generateFixtureCatalog(root),
    ]);
    const manifest = fixtureManifestSchema.parse(
      JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8')),
    );
    expect(manifest.length).toBeGreaterThanOrEqual(250);
    expect(
      readdirSync(root).filter((name) => name.startsWith('.schema-generation')),
    ).toEqual([]);
    for (const entry of manifest) {
      expect(existsSync(join(root, entry.file))).toBe(true);
    }
  });

  test('generates a deterministic, self-validating required case matrix', async () => {
    const first = temporaryRoot('schema-fixtures-first-');
    const second = temporaryRoot('schema-fixtures-second-');
    await generateFixtureCatalog(first);
    await generateFixtureCatalog(second);

    const firstManifestBytes = readFileSync(join(first, 'manifest.json'));
    const secondManifestBytes = readFileSync(join(second, 'manifest.json'));
    expect(firstManifestBytes.equals(secondManifestBytes)).toBe(true);
    const manifest = fixtureManifestSchema.parse(
      JSON.parse(firstManifestBytes.toString('utf8')),
    );
    const ids = new Set(manifest.map(({ id }) => id));
    for (const required of [
      'optional.absent',
      'nullable.null',
      'optional-nullable.absent',
      'optional-nullable.null',
      'optional-nullable.value',
      'unknown.durable.non-critical',
      'unknown.transient.non-critical',
      'unknown.critical',
      'cursor.above-safe-integer',
      'command-ack.original',
      'command-ack.replayed',
      'snapshot-reset.without-runtime',
      'snapshot-reset.with-runtime',
      'credential-ref',
      'union.SubmissionResult.runCreated',
      'union.SubmissionResult.queueItemCreated',
      'union.OperationTerminalEventPayload.completed',
      'union.OperationTerminalEventPayload.failed',
      'union.OperationTerminalEventPayload.cancelled',
      'union.AssistantTranscriptPayload.streaming',
      'union.AssistantTranscriptPayload.interrupted',
      'union.AssistantTranscriptPayload.completed',
      'known-event.malformed.protocol-error',
      'reject.nested-secret',
      'reject.unknown-top-level',
      'reject.unknown-nested',
    ]) {
      expect(ids.has(required), required).toBe(true);
    }

    const unionSchemas = Object.entries(contractRegistry.schemas).filter(
      (entry): entry is [string, z.ZodDiscriminatedUnion] =>
        entry[1] instanceof z.ZodDiscriminatedUnion,
    );
    for (const [name, schema] of unionSchemas) {
      const target = `schema:${name}`;
      const discriminator = (schema._zod.def as { discriminator: string })
        .discriminator;
      const expected = schema.options.map(
        (option) => option.shape[discriminator]!.value as string,
      );
      const actual = manifest
        .filter((entry) => entry.schema === target && entry.expect === 'accept')
        .map((entry) => {
          const value = JSON.parse(
            readFileSync(join(first, entry.file), 'utf8'),
          ) as Record<string, unknown>;
          return value[discriminator] as string;
        });
      expect(new Set(actual), target).toEqual(new Set(expected));
      expect(actual, `${target} branch count`).toHaveLength(expected.length);
    }
    for (const target of [
      'schema:KnownDurableEventEnvelope',
      'schema:KnownTransientEventEnvelope',
    ]) {
      const entries = manifest.filter((entry) => entry.schema === target);
      expect(entries.length, target).toBeGreaterThan(0);
      expect(
        entries.every(({ expectedOutcome }) => expectedOutcome === 'known'),
        `${target} parser outcomes`,
      ).toBe(true);
    }

    const runtimeReset = JSON.parse(
      readFileSync(
        join(first, 'valid/snapshot-reset.with-runtime.json'),
        'utf8',
      ),
    ) as { snapshot?: { streamState?: unknown } };
    expect(runtimeReset.snapshot?.streamState).toBeDefined();
    const malformedKnown = manifest.find(
      ({ id }) => id === 'known-event.malformed.protocol-error',
    );
    expect(malformedKnown).toMatchObject({
      expect: 'reject',
      expectedOutcome: 'protocolError',
      schema: 'schema:ThreadStreamFrame',
    });

    for (const entry of manifest) {
      const firstBytes = readFileSync(join(first, entry.file));
      expect(firstBytes.equals(readFileSync(join(second, entry.file)))).toBe(
        true,
      );
      const value = JSON.parse(firstBytes.toString('utf8'));
      expect(resolveFixtureSchema(entry.schema).safeParse(value).success).toBe(
        entry.expect === 'accept',
      );
    }
    expect(firstManifestBytes.toString('utf8')).not.toContain(
      'not-a-secret-value',
    );
  });
});
