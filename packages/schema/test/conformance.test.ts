import { afterEach, describe, expect, test } from 'bun:test';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  loadConformanceManifest,
  runConformanceCatalog,
} from '../scripts/lib/conformance.js';

const GOLDEN_ROOT = resolve(import.meta.dir, '../fixtures/golden');
const temporaryRoots: string[] = [];

const copyCatalog = () => {
  const parent = mkdtempSync(join(tmpdir(), 'schema-conformance-'));
  temporaryRoots.push(parent);
  const root = join(parent, 'golden');
  cpSync(GOLDEN_ROOT, root, { recursive: true });
  return root;
};

const mutateManifest = (
  root: string,
  mutate: (manifest: Array<Record<string, unknown>>) => void,
) => {
  const path = join(root, 'manifest.json');
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as Array<
    Record<string, unknown>
  >;
  mutate(manifest);
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
};

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe('TypeScript conformance runner', () => {
  test('runs every immutable-registry fixture and all semantic outcomes', () => {
    const report = runConformanceCatalog(GOLDEN_ROOT);

    expect(report.fixtureCount).toBe(252);
    expect(report.outcomes).toEqual({
      known: 19,
      protocolError: 1,
      resetRequired: 1,
      unknownNonCritical: 4,
    });
    expect(report.preservedCursors).toContain('9007199254740993');
  });

  test('fails when schema parse acceptance differs from expect', () => {
    const root = copyCatalog();
    writeFileSync(join(root, 'valid/optional.absent.json'), '42\n');

    expect(() => runConformanceCatalog(root)).toThrow(/expectation mismatch/i);
  });

  test('checks parser outcomes rather than only Zod acceptance', () => {
    const root = copyCatalog();
    const path = join(root, 'valid/unknown.critical.json');
    const fixture = JSON.parse(readFileSync(path, 'utf8')) as Record<
      string,
      unknown
    >;
    fixture.critical = false;
    writeFileSync(path, `${JSON.stringify(fixture, null, 2)}\n`);

    expect(() => runConformanceCatalog(root)).toThrow(/outcome mismatch/i);
  });

  test('requires authored semantic outcomes even when Zod accepts', () => {
    for (const id of [
      'unknown.critical',
      'union.KnownDurableEventEnvelope.thread.updated',
    ]) {
      const root = copyCatalog();
      mutateManifest(root, (manifest) => {
        const entry = manifest.find((candidate) => candidate.id === id);
        if (entry !== undefined) delete entry.expectedOutcome;
      });

      expect(() => runConformanceCatalog(root)).toThrow(/required outcome/i);
    }
  });

  test('asserts the above-safe-integer cursor as its exact string value', () => {
    const root = copyCatalog();
    writeFileSync(
      join(root, 'valid/cursor.above-safe-integer.json'),
      '"9007199254740994"\n',
    );

    expect(() => runConformanceCatalog(root)).toThrow(/64-bit cursor/i);
  });

  test('rejects unknown schema targets without disclosing them', () => {
    const root = copyCatalog();
    const sentinel = 'SENTINEL_SCHEMA_TARGET';
    mutateManifest(root, (manifest) => {
      manifest[0]!.schema = `schema:${sentinel}`;
    });

    expect(() => runConformanceCatalog(root)).toThrow(/schema target/i);
    try {
      runConformanceCatalog(root);
    } catch (error) {
      expect(String(error)).not.toContain(sentinel);
    }
  });

  test('rejects duplicate ids', () => {
    const root = copyCatalog();
    mutateManifest(root, (manifest) => {
      manifest[1]!.id = manifest[0]!.id;
    });

    expect(() => runConformanceCatalog(root)).toThrow(/manifest/i);
  });

  test('rejects orphan fixture JSON files', () => {
    const root = copyCatalog();
    writeFileSync(join(root, 'valid/orphan.json'), '{}\n');

    expect(() => runConformanceCatalog(root)).toThrow(/orphan/i);
  });

  test('treats every ordinary file in the fixture tree as managed', () => {
    const root = copyCatalog();
    writeFileSync(join(root, 'valid/SENTINEL_ORPHAN.txt'), 'not JSON\n');

    expect(() => runConformanceCatalog(root)).toThrow(/orphan/i);
  });

  test('rejects unmanaged entries at the golden root', () => {
    const root = copyCatalog();
    const sentinel = 'SENTINEL_ROOT_ENTRY.txt';
    writeFileSync(join(root, sentinel), 'unmanaged\n');

    try {
      runConformanceCatalog(root);
      throw new Error('expected catalog root rejection');
    } catch (error) {
      expect(String(error)).toContain('invalid conformance catalog');
      expect(String(error)).not.toContain(sentinel);
    }
  });

  test('rejects missing dynamically required enum and union branches', () => {
    for (const id of [
      'enum.WorkspaceTrust.untrusted',
      'union.SubmissionResult.queueItemCreated',
    ]) {
      const root = copyCatalog();
      let file = '';
      mutateManifest(root, (manifest) => {
        const index = manifest.findIndex((entry) => entry.id === id);
        file = String(manifest[index]!.file);
        manifest.splice(index, 1);
      });
      unlinkSync(join(root, file));

      expect(() => runConformanceCatalog(root)).toThrow(/required category/i);
    }
  });

  test('requires every ApiError ErrorCode and fixed authoring category', () => {
    for (const id of [
      'api-error.INTERNAL_ERROR',
      'cursor.above-safe-integer',
      'reject.nested-secret',
    ]) {
      const root = copyCatalog();
      let file = '';
      mutateManifest(root, (manifest) => {
        const index = manifest.findIndex((entry) => entry.id === id);
        file = String(manifest[index]!.file);
        manifest.splice(index, 1);
      });
      unlinkSync(join(root, file));

      expect(() => runConformanceCatalog(root)).toThrow(/required category/i);
    }
  });

  test('binds required categories to their authored accept or reject result', () => {
    const root = copyCatalog();
    mutateManifest(root, (manifest) => {
      const entry = manifest.find(
        (candidate) =>
          candidate.id === 'union.SubmissionResult.queueItemCreated',
      );
      if (entry !== undefined) entry.expect = 'reject';
    });
    writeFileSync(
      join(root, 'valid/union.SubmissionResult.queueItemCreated.json'),
      '{"kind":"queueItemCreated"}\n',
    );

    expect(() => runConformanceCatalog(root)).toThrow(/required category/i);
  });

  test('binds required fixture contents to their authored ids', () => {
    for (const [target, source] of [
      [
        'valid/enum.WorkspaceTrust.untrusted.json',
        'valid/enum.WorkspaceTrust.trusted.json',
      ],
      [
        'valid/union.SubmissionResult.queueItemCreated.json',
        'valid/union.SubmissionResult.runCreated.json',
      ],
      [
        'valid/api-error.INTERNAL_ERROR.json',
        'valid/api-error.VALIDATION_ERROR.json',
      ],
      ['valid/command-ack.original.json', 'valid/command-ack.replayed.json'],
      [
        'valid/snapshot-reset.without-runtime.json',
        'valid/snapshot-reset.with-runtime.json',
      ],
    ]) {
      const root = copyCatalog();
      writeFileSync(
        join(root, target),
        readFileSync(join(root, source), 'utf8'),
      );

      expect(() => runConformanceCatalog(root)).toThrow(/fixture semantics/i);
    }
  });

  test('does not accept one strict rejection as another category', () => {
    for (const [target, source] of [
      ['reject.nested-secret.json', 'reject.unknown-nested.json'],
      ['reject.unknown-top-level.json', 'reject.unknown-nested.json'],
    ]) {
      const root = copyCatalog();
      writeFileSync(
        join(root, 'invalid', target),
        readFileSync(join(root, 'invalid', source), 'utf8'),
      );

      expect(() => runConformanceCatalog(root)).toThrow(/fixture semantics/i);
    }
  });

  test('binds unknown and malformed event categories to authored shapes', () => {
    const swapped = copyCatalog();
    writeFileSync(
      join(swapped, 'valid/unknown.durable.non-critical.json'),
      readFileSync(
        join(swapped, 'valid/unknown.transient.non-critical.json'),
        'utf8',
      ),
    );
    expect(() => runConformanceCatalog(swapped)).toThrow(/fixture semantics/i);

    const critical = copyCatalog();
    const transientPath = join(
      critical,
      'valid/unknown.transient.non-critical.json',
    );
    const transient = JSON.parse(readFileSync(transientPath, 'utf8')) as Record<
      string,
      unknown
    >;
    transient.critical = true;
    writeFileSync(
      join(critical, 'valid/unknown.critical.json'),
      `${JSON.stringify(transient)}\n`,
    );
    expect(() => runConformanceCatalog(critical)).toThrow(/fixture semantics/i);

    const malformed = copyCatalog();
    writeFileSync(
      join(malformed, 'invalid/known-event.malformed.protocol-error.json'),
      '{}\n',
    );
    expect(() => runConformanceCatalog(malformed)).toThrow(
      /fixture semantics/i,
    );
  });

  test('rejects malformed JSON without disclosing fixture payload', () => {
    const root = copyCatalog();
    const sentinel = 'SENTINEL_FIXTURE_PAYLOAD';
    writeFileSync(
      join(root, 'valid/optional.absent.json'),
      `{"secret":"${sentinel}"`,
    );

    expect(() => runConformanceCatalog(root)).toThrow(/fixture JSON/i);
    try {
      runConformanceCatalog(root);
    } catch (error) {
      expect(String(error)).not.toContain(sentinel);
    }
  });

  test('confines manifest and fixture paths and rejects symlinks', () => {
    const escaped = copyCatalog();
    const sentinel = 'SENTINEL_PATH';
    mutateManifest(escaped, (manifest) => {
      manifest[0]!.file = `../${sentinel}.json`;
    });
    expect(() => runConformanceCatalog(escaped)).toThrow(/fixture path/i);
    try {
      runConformanceCatalog(escaped);
    } catch (error) {
      expect(String(error)).not.toContain(sentinel);
    }

    const linked = copyCatalog();
    const fixture = join(linked, 'valid/optional.absent.json');
    unlinkSync(fixture);
    symlinkSync(join(linked, 'valid/nullable.null.json'), fixture);
    expect(() => runConformanceCatalog(linked)).toThrow(
      /symlink|fixture tree/i,
    );
  });

  test('fails closed when a checked file is replaced before fd open', () => {
    for (const kind of ['manifest', 'fixture'] as const) {
      const root = copyCatalog();
      const outside = join(root, '..', `outside-${kind}.json`);
      const sentinel = `SENTINEL_RACE_${kind.toUpperCase()}`;
      writeFileSync(outside, `{"secret":"${sentinel}"}\n`);
      let replaced = false;

      try {
        runConformanceCatalog(root, {
          afterFilePathCheck: (candidate) => {
            if (
              !replaced &&
              candidate.kind === kind &&
              (kind === 'manifest' ||
                candidate.path.endsWith('valid/optional.absent.json'))
            ) {
              replaced = true;
              unlinkSync(candidate.path);
              symlinkSync(outside, candidate.path);
            }
          },
        });
        throw new Error('expected secure read rejection');
      } catch (error) {
        expect(String(error)).not.toContain(sentinel);
        expect(String(error)).not.toContain(outside);
      }
      expect(replaced).toBe(true);
    }
  });

  test('detects same-inode writes before and after fd reads', () => {
    for (const phase of ['afterFilePathCheck', 'afterFileRead'] as const) {
      const root = copyCatalog();
      let changed = false;
      const mutate = (candidate: { kind: string; path: string }) => {
        if (
          !changed &&
          candidate.kind === 'fixture' &&
          candidate.path.endsWith('valid/optional.absent.json')
        ) {
          changed = true;
          writeFileSync(candidate.path, '[]\n');
        }
      };

      try {
        runConformanceCatalog(root, { [phase]: mutate });
        throw new Error('expected in-place mutation rejection');
      } catch (error) {
        expect(String(error)).not.toContain(join(root, 'valid'));
      }
      expect(changed).toBe(true);
    }
  });

  test('rejects a compatible catalog publication midway through the run', () => {
    const root = copyCatalog();
    const first = join(root, 'valid/api-error.APPROVAL_EXPIRED.json');
    const second = join(root, 'valid/api-error.AUTHENTICATION_REQUIRED.json');
    const temporary = join(root, 'valid/swap.tmp');
    let reads = 0;
    let swapped = false;

    expect(() =>
      runConformanceCatalog(root, {
        afterFixtureRead: () => {
          reads += 1;
          if (reads === 100) {
            renameSync(first, temporary);
            renameSync(second, first);
            renameSync(temporary, second);
            swapped = true;
          }
        },
      }),
    ).toThrow(/catalog changed/i);
    expect(swapped).toBe(true);
  });

  test('redacts a directory entry removed after readdir', () => {
    const root = copyCatalog();
    const sentinel = 'SENTINEL_DIRECTORY_ENTRY.txt';
    const path = join(root, 'valid', sentinel);
    writeFileSync(path, 'fixture tree sentinel\n');
    let removed = false;

    try {
      runConformanceCatalog(root, {
        afterDirectoryRead: ({ directory }) => {
          if (!removed && directory.endsWith('/valid')) {
            removed = true;
            unlinkSync(path);
          }
        },
      });
      throw new Error('expected fixture tree rejection');
    } catch (error) {
      expect(String(error)).toContain('invalid fixture tree');
      expect(String(error)).not.toContain(sentinel);
      expect(String(error)).not.toContain(path);
    }
    expect(removed).toBe(true);
  });

  test('rejects symlinked or non-file entries during orphan scanning', () => {
    const root = copyCatalog();
    const target = join(root, 'valid/nullable.null.json');
    symlinkSync(target, join(root, 'invalid/linked.json'));
    expect(() => runConformanceCatalog(root)).toThrow(/fixture tree/i);

    const directoryRoot = copyCatalog();
    const directory = join(directoryRoot, 'valid/directory.json');
    mkdirSync(directory);
    expect(() => runConformanceCatalog(directoryRoot)).toThrow(/fixture tree/i);
  });

  test('redacts malformed manifest syntax and schema details', () => {
    const root = copyCatalog();
    const sentinel = 'SENTINEL_MANIFEST';
    writeFileSync(join(root, 'manifest.json'), `[{"id":"${sentinel}"`);

    expect(() => loadConformanceManifest(root)).toThrow(/manifest/i);
    try {
      loadConformanceManifest(root);
    } catch (error) {
      expect(String(error)).not.toContain(sentinel);
    }
  });

  test('exposes a package-manager runnable conformance script', () => {
    const packageJson = JSON.parse(
      readFileSync(resolve(import.meta.dir, '../package.json'), 'utf8'),
    ) as { scripts?: Record<string, string> };

    expect(packageJson.scripts?.['test:conformance']).toBe(
      'bun test test/conformance.test.ts',
    );
  });
});
