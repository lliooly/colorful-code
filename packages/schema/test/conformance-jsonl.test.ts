import { afterEach, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  compareConformanceRecords,
  parseConformanceJsonLines,
  readConformanceJsonLines,
  serializeConformanceJsonLines,
  writeConformanceJsonLines,
  type ConformanceRecord,
} from '../scripts/lib/conformance-jsonl.js';
import {
  compareConformanceFiles,
  runCrossLanguageConformance,
  runConformanceCommands,
  withConformanceWorkspace,
} from '../scripts/compare-conformance.js';
import { runTypeScriptConformance } from '../scripts/write-conformance-jsonl.js';

const GOLDEN_ROOT = resolve(import.meta.dir, '../fixtures/golden');
const SWIFT_CONFORMANCE_EXECUTABLE = resolve(
  import.meta.dir,
  '../swift-fixture/.build/out/Products/Debug/ColorfulCodeConformance',
);

const temporaryRoots: string[] = [];

const temporaryRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'schema-jsonl-test-'));
  temporaryRoots.push(root);
  return root;
};

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe('conformance JSONL', () => {
  const records: readonly ConformanceRecord[] = [
    { id: 'z-last', outcome: 'reject' },
    { id: 'a-first', outcome: 'known' },
  ];

  test('serializes canonical records in fixture id order', () => {
    expect(serializeConformanceJsonLines(records)).toBe(
      '{"id":"a-first","outcome":"known"}\n' +
        '{"id":"z-last","outcome":"reject"}\n',
    );
  });

  test('sorts ids by UTF-8 bytes across language runtimes', () => {
    expect(
      serializeConformanceJsonLines([
        { id: '\u{e000}', outcome: 'known' },
        { id: '\u{10000}', outcome: 'known' },
      ]),
    ).toBe(
      `${JSON.stringify({ id: '\u{e000}', outcome: 'known' })}\n` +
        `${JSON.stringify({ id: '\u{10000}', outcome: 'known' })}\n`,
    );
  });

  test('rejects an empty record stream', () => {
    expect(() => serializeConformanceJsonLines([])).toThrow(
      'invalid conformance JSONL',
    );
  });

  test.each([
    ['unknown field', '{"id":"a","outcome":"known","extra":true}\n'],
    ['illegal outcome', '{"id":"a","outcome":"success"}\n'],
    [
      'duplicate id',
      '{"id":"a","outcome":"known"}\n{"id":"a","outcome":"known"}\n',
    ],
    [
      'unsorted ids',
      '{"id":"b","outcome":"known"}\n{"id":"a","outcome":"known"}\n',
    ],
    ['missing final newline', '{"id":"a","outcome":"known"}'],
    ['blank tail', '{"id":"a","outcome":"known"}\n\n'],
    ['trailing data', '{"id":"a","outcome":"known"}\ntrailing\n'],
    ['non-canonical whitespace', '{ "id":"a","outcome":"known"}\n'],
  ])('rejects %s', (_name, source) => {
    expect(() => parseConformanceJsonLines(source)).toThrow(
      'invalid conformance JSONL',
    );
  });

  test('requires exact fixture sets and outcomes', () => {
    expect(() => compareConformanceRecords([], [])).toThrow(
      'conformance result mismatch',
    );
    expect(() =>
      compareConformanceRecords(
        [{ id: 'a', outcome: 'known' }],
        [{ id: 'b', outcome: 'known' }],
      ),
    ).toThrow('conformance result mismatch');
    expect(() =>
      compareConformanceRecords(
        [{ id: 'a', outcome: 'known' }],
        [{ id: 'a', outcome: 'reject' }],
      ),
    ).toThrow('conformance result mismatch');
  });

  test('writes a new regular 0600 file inside a private root', () => {
    const root = temporaryRoot();
    chmodSync(root, 0o700);

    const path = writeConformanceJsonLines(root, 'typescript.jsonl', records);

    expect(path).toBe(join(realpathSync(resolve(root)), 'typescript.jsonl'));
    expect(readFileSync(path, 'utf8')).toBe(
      serializeConformanceJsonLines(records),
    );
    expect(lstatSync(path).mode & 0o777).toBe(0o600);
  });

  test('enforces 0600 output under a restrictive process umask', () => {
    const root = temporaryRoot();
    chmodSync(root, 0o700);
    const previous = process.umask(0o777);
    let path = '';
    try {
      path = writeConformanceJsonLines(root, 'umask.jsonl', records);
    } finally {
      process.umask(previous);
    }

    expect(lstatSync(path).mode & 0o777).toBe(0o600);
  });

  test('rejects output larger than the secure reader limit', () => {
    const root = temporaryRoot();
    chmodSync(root, 0o700);

    expect(() =>
      writeConformanceJsonLines(root, 'oversized.jsonl', [
        { id: 'x'.repeat(4 * 1024 * 1024), outcome: 'known' },
      ]),
    ).toThrow('invalid conformance output');
    expect(existsSync(join(root, 'oversized.jsonl'))).toBe(false);
  });

  test('rejects traversal, symlink roots, existing outputs, and non-private roots', () => {
    const root = temporaryRoot();
    chmodSync(root, 0o700);
    expect(() =>
      writeConformanceJsonLines(root, '../escape.jsonl', records),
    ).toThrow('invalid conformance output');

    const existing = join(root, 'existing.jsonl');
    writeFileSync(existing, 'sentinel');
    expect(() =>
      writeConformanceJsonLines(root, 'existing.jsonl', records),
    ).toThrow('invalid conformance output');
    expect(readFileSync(existing, 'utf8')).toBe('sentinel');

    const linked = join(temporaryRoot(), 'linked');
    symlinkSync(root, linked);
    expect(() =>
      writeConformanceJsonLines(linked, 'linked.jsonl', records),
    ).toThrow('invalid conformance output');

    const broad = temporaryRoot();
    chmodSync(broad, 0o755);
    expect(() =>
      writeConformanceJsonLines(broad, 'broad.jsonl', records),
    ).toThrow('invalid conformance output');
  });

  test('scrubs a same-inode partial output without unlinking by path', () => {
    const root = temporaryRoot();
    chmodSync(root, 0o700);

    expect(() =>
      writeConformanceJsonLines(root, 'partial.jsonl', records, {
        afterOutputOpen: () => {
          throw new Error('injected write failure');
        },
      }),
    ).toThrow('invalid conformance output');
    expect(readFileSync(join(root, 'partial.jsonl'))).toHaveLength(0);
  });

  test('fails closed when the private output root is replaced after validation', () => {
    const root = temporaryRoot();
    chmodSync(root, 0o700);
    const moved = `${root}-moved`;
    temporaryRoots.push(moved);

    expect(() =>
      writeConformanceJsonLines(root, 'swapped.jsonl', records, {
        afterRootOpen: () => {
          renameSync(root, moved);
          mkdirSync(root, { mode: 0o700 });
        },
      }),
    ).toThrow('invalid conformance output');
    expect(existsSync(join(root, 'swapped.jsonl'))).toBe(false);
    expect(existsSync(join(moved, 'swapped.jsonl'))).toBe(false);
  });

  test('rejects a root swap restored around output open and scrubs the unbound file', () => {
    const root = temporaryRoot();
    chmodSync(root, 0o700);
    const moved = `${root}-original`;
    const replacement = `${root}-replacement`;
    temporaryRoots.push(moved, replacement);
    let beforeOpen = false;
    let afterOpen = false;

    expect(() =>
      writeConformanceJsonLines(root, 'raced.jsonl', records, {
        beforeOutputOpen: () => {
          beforeOpen = true;
          renameSync(root, moved);
          mkdirSync(root, { mode: 0o700 });
        },
        afterOutputOpen: () => {
          afterOpen = true;
          renameSync(root, replacement);
          renameSync(moved, root);
        },
      }),
    ).toThrow('invalid conformance output');
    expect(beforeOpen).toBe(true);
    expect(afterOpen).toBe(true);
    expect(existsSync(join(root, 'raced.jsonl'))).toBe(false);
    expect(readFileSync(join(replacement, 'raced.jsonl'))).toHaveLength(0);
  });

  test('does not unlink a replacement path during failed-output cleanup', () => {
    const root = temporaryRoot();
    chmodSync(root, 0o700);
    const path = join(root, 'raced-unlink.jsonl');
    const moved = join(root, 'original-partial.jsonl');

    expect(() =>
      writeConformanceJsonLines(root, 'raced-unlink.jsonl', records, {
        afterOutputOpen: () => {
          throw new Error('injected write failure');
        },
        beforeFailedOutputUnlink: () => {
          renameSync(path, moved);
          writeFileSync(path, 'keep', { mode: 0o600 });
        },
      }),
    ).toThrow('invalid conformance output');
    expect(readFileSync(path, 'utf8')).toBe('keep');
    expect(readFileSync(moved)).toHaveLength(0);
  });

  test('fails closed when the private input root is replaced after validation', () => {
    const root = temporaryRoot();
    chmodSync(root, 0o700);
    writeConformanceJsonLines(root, 'result.jsonl', records);
    const moved = `${root}-read-moved`;
    temporaryRoots.push(moved);

    expect(() =>
      readConformanceJsonLines(root, 'result.jsonl', {
        afterRootOpen: () => {
          renameSync(root, moved);
          mkdirSync(root, { mode: 0o700 });
          writeFileSync(join(root, 'result.jsonl'), 'SENTINEL_REPLACEMENT');
        },
      }),
    ).toThrow('invalid conformance output');
  });

  test('writes all validated TypeScript outcomes without payload data', () => {
    const root = temporaryRoot();
    chmodSync(root, 0o700);

    const path = runTypeScriptConformance({
      fixtureRoot: GOLDEN_ROOT,
      outputName: 'typescript.jsonl',
      outputRoot: root,
    });
    const source = readFileSync(path, 'utf8');
    const parsed = parseConformanceJsonLines(source);

    expect(parsed).toHaveLength(254);
    expect(parsed.find(({ id }) => id === 'unknown.critical')).toEqual({
      id: 'unknown.critical',
      outcome: 'resetRequired',
    });
    expect(source).not.toContain('not-a-secret-value');
  });

  test('compares securely-read canonical output files', () => {
    const root = temporaryRoot();
    chmodSync(root, 0o700);
    writeConformanceJsonLines(root, 'typescript.jsonl', records);
    writeConformanceJsonLines(root, 'swift.jsonl', records);

    expect(() =>
      compareConformanceFiles(root, 'typescript.jsonl', 'swift.jsonl'),
    ).not.toThrow();

    const linkedRoot = temporaryRoot();
    chmodSync(linkedRoot, 0o700);
    symlinkSync(
      join(root, 'typescript.jsonl'),
      join(linkedRoot, 'typescript.jsonl'),
    );
    writeConformanceJsonLines(linkedRoot, 'swift.jsonl', records);
    expect(() =>
      compareConformanceFiles(linkedRoot, 'typescript.jsonl', 'swift.jsonl'),
    ).toThrow('invalid conformance output');
  });

  test('rejects broad output permissions and malformed UTF-8', () => {
    const root = temporaryRoot();
    chmodSync(root, 0o700);
    const broad = writeConformanceJsonLines(root, 'broad.jsonl', records);
    chmodSync(broad, 0o644);
    expect(() => readConformanceJsonLines(root, 'broad.jsonl')).toThrow(
      'invalid conformance output',
    );

    const malformed = join(root, 'malformed.jsonl');
    writeFileSync(malformed, Buffer.from([0xff, 0x0a]), { mode: 0o600 });
    expect(() => readConformanceJsonLines(root, 'malformed.jsonl')).toThrow(
      'invalid conformance output',
    );
  });
});

describe('cross-language orchestration', () => {
  const records: readonly ConformanceRecord[] = [
    { id: 'a-first', outcome: 'known' },
  ];

  test('exposes explicit package scripts for Swift and cross-language checks', () => {
    const packageJson = JSON.parse(
      readFileSync(resolve(import.meta.dir, '../package.json'), 'utf8'),
    ) as { scripts?: Record<string, string> };

    expect(packageJson.scripts?.['test:swift-conformance']).toBe(
      'bun scripts/compare-conformance.ts --swift-only --fixture-root fixtures/golden',
    );
    expect(packageJson.scripts?.['test:cross-language']).toBe(
      'bun scripts/compare-conformance.ts --fixture-root fixtures/golden',
    );
  });

  test('TypeScript CLI takes explicit paths and writes no payload to stdout', () => {
    const root = temporaryRoot();
    chmodSync(root, 0o700);
    const script = resolve(
      import.meta.dir,
      '../scripts/write-conformance-jsonl.ts',
    );

    const result = Bun.spawnSync([
      process.execPath,
      script,
      '--fixture-root',
      GOLDEN_ROOT,
      '--output-root',
      root,
      '--output-name',
      'typescript.jsonl',
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe('');
    expect(
      parseConformanceJsonLines(
        readFileSync(join(root, 'typescript.jsonl'), 'utf8'),
      ),
    ).toHaveLength(254);
  });

  test('TypeScript CLI rejects malformed arguments with a fixed redacted error', () => {
    const sentinel = 'SENTINEL_ARGUMENT_VALUE';
    const result = Bun.spawnSync([
      process.execPath,
      resolve(import.meta.dir, '../scripts/write-conformance-jsonl.ts'),
      '--fixture-root',
      sentinel,
    ]);

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout.toString()).toBe('');
    expect(result.stderr.toString()).toContain('typescript conformance failed');
    expect(result.stderr.toString()).not.toContain(sentinel);
  });

  test.skipIf(!existsSync(SWIFT_CONFORMANCE_EXECUTABLE))(
    'Swift CLI takes explicit paths and writes canonical payload-free JSONL',
    () => {
      const root = temporaryRoot();
      chmodSync(root, 0o700);
      const result = Bun.spawnSync([
        SWIFT_CONFORMANCE_EXECUTABLE,
        '--fixture-root',
        GOLDEN_ROOT,
        '--output-root',
        root,
        '--output-name',
        'swift.jsonl',
      ]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString()).toBe('');
      const source = readFileSync(join(root, 'swift.jsonl'), 'utf8');
      expect(parseConformanceJsonLines(source)).toHaveLength(254);
      expect(source).not.toContain('not-a-secret-value');
    },
    180_000,
  );

  test('Swift directory enumeration distinguishes EOF from readdir failure', () => {
    const source = readFileSync(
      resolve(
        import.meta.dir,
        '../swift-fixture/Sources/GoldenFixtureSupport/GoldenFixtureRunner.swift',
      ),
      'utf8',
    );

    expect(source).toContain('errno = 0');
    expect(source).toContain('guard errno == 0 else');

    const commandSource = readFileSync(
      resolve(
        import.meta.dir,
        '../swift-fixture/Sources/ColorfulCodeConformance/main.swift',
      ),
      'utf8',
    );
    expect(commandSource).toContain('Darwin.ftruncate(descriptor, 0)');
  });

  test('cross-language CLI rejects malformed arguments with a fixed redacted error', () => {
    const sentinel = 'SENTINEL_CROSS_LANGUAGE_ARGUMENT';
    const result = Bun.spawnSync([
      process.execPath,
      resolve(import.meta.dir, '../scripts/compare-conformance.ts'),
      '--fixture-root',
      sentinel,
      '--unknown',
    ]);

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout.toString()).toBe('');
    expect(result.stderr.toString()).toContain(
      'cross-language conformance failed',
    );
    expect(result.stderr.toString()).not.toContain(sentinel);
  });

  test('runs TypeScript before Swift and stops on the first nonzero status', () => {
    const calls: string[][] = [];
    const execute = (command: readonly string[]) => {
      calls.push([...command]);
      return command.includes('typescript') ? 17 : 0;
    };

    expect(() =>
      runConformanceCommands(
        [
          ['bun', 'typescript'],
          ['swift', 'swift'],
        ],
        execute,
      ),
    ).toThrow('conformance command failed');
    expect(calls).toEqual([['bun', 'typescript']]);
  });

  test('isolates SwiftPM scratch state inside each private workspace', () => {
    let command: readonly string[] = [];

    expect(() =>
      runCrossLanguageConformance(
        { fixtureRoot: GOLDEN_ROOT, swiftOnly: true },
        (candidate) => {
          command = candidate;
          return candidate[0] === 'swift' && candidate[1] === 'run' ? 17 : 0;
        },
      ),
    ).toThrow('conformance command failed');

    const outputRootIndex = command.indexOf('--output-root');
    const scratchPathIndex = command.indexOf('--scratch-path');
    expect(outputRootIndex).toBeGreaterThanOrEqual(0);
    expect(scratchPathIndex).toBeGreaterThanOrEqual(0);
    expect(command[scratchPathIndex + 1]).toBe(
      join(command[outputRootIndex + 1]!, '.swift-build'),
    );
  });

  test('Swift-only mode executes XCTest with the built CLI before conformance', () => {
    const commands: string[][] = [];

    runCrossLanguageConformance(
      { fixtureRoot: GOLDEN_ROOT, swiftOnly: true },
      (candidate) => {
        const command = [...candidate];
        commands.push(command);
        if (command[0] === 'swift' && command[1] === 'run') {
          const outputRoot = command[command.indexOf('--output-root') + 1]!;
          writeConformanceJsonLines(outputRoot, 'swift.jsonl', records);
        }
        return 0;
      },
    );

    expect(commands).toHaveLength(3);
    expect(commands[0]?.slice(0, 2)).toEqual(['swift', 'build']);
    expect(commands[1]).toContain('swift');
    expect(commands[1]).toContain('test');
    expect(
      commands[1]?.some((part) =>
        part.startsWith('SCHEMA_GOLDEN_FIXTURE_ROOT='),
      ),
    ).toBe(true);
    expect(
      commands[1]?.some((part) =>
        part.startsWith('SCHEMA_CONFORMANCE_EXECUTABLE='),
      ),
    ).toBe(true);
    expect(commands[2]?.slice(0, 2)).toEqual(['swift', 'run']);
  });

  test('creates isolated private workspaces for concurrent runs and cleans them', async () => {
    const roots = await Promise.all(
      Array.from({ length: 12 }, async () =>
        withConformanceWorkspace((root) => {
          expect(lstatSync(root).isSymbolicLink()).toBe(false);
          expect(lstatSync(root).mode & 0o777).toBe(0o700);
          return root;
        }),
      ),
    );

    expect(new Set(roots).size).toBe(roots.length);
    for (const root of roots) expect(() => lstatSync(root)).toThrow();
  });

  test('does not recursively remove a replacement workspace directory', () => {
    let root = '';
    let moved = '';
    expect(() =>
      withConformanceWorkspace((workspace) => {
        root = workspace;
        moved = `${workspace}-moved`;
        renameSync(workspace, moved);
        mkdirSync(workspace, { mode: 0o700 });
      }),
    ).toThrow('conformance workspace changed');

    try {
      expect(lstatSync(root).isDirectory()).toBe(true);
      expect(lstatSync(moved).isDirectory()).toBe(true);
    } finally {
      rmSync(root, { force: true, recursive: true });
      rmSync(moved, { force: true, recursive: true });
    }
  });

  test('pins the cleanup directory inode before recursive removal', () => {
    let replacement = '';
    let moved = '';

    expect(() =>
      withConformanceWorkspace(() => undefined, {
        beforeWorkspaceRemoval: (cleanupRoot) => {
          moved = `${cleanupRoot}-original`;
          replacement = cleanupRoot;
          renameSync(cleanupRoot, moved);
          mkdirSync(replacement, { mode: 0o700 });
          writeFileSync(join(replacement, 'sentinel'), 'keep');
        },
      }),
    ).toThrow('conformance workspace changed');

    try {
      expect(readFileSync(join(replacement, 'sentinel'), 'utf8')).toBe('keep');
    } finally {
      rmSync(replacement, { force: true, recursive: true });
      rmSync(moved, { force: true, recursive: true });
    }
  });
});
