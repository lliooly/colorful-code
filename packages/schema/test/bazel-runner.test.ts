import { afterEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  bazelRunnerTestSeams,
  parseOutputArguments,
  runBazelCodegen,
} from '../scripts/bazel-runner.js';
import { createContractOutputs } from '../scripts/create-contract-outputs.js';

const temporaryDirectories: string[] = [];

const makeDirectory = (): string => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'bazel-runner-')));
  temporaryDirectories.push(directory);
  return directory;
};

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const outputPaths = (root: string) => ({
  openapi: join(root, 'openapi.v2.json'),
  events: join(root, 'events.schema.json'),
  typescript: join(root, 'contracts.ts'),
  swift: join(root, 'ColorfulCodeContracts.swift'),
});

const argumentsFor = (
  paths: ReturnType<typeof outputPaths>,
): readonly string[] => [
  `--openapi=${paths.openapi}`,
  `--events=${paths.events}`,
  `--typescript=${paths.typescript}`,
  `--swift=${paths.swift}`,
];

describe('parseOutputArguments', () => {
  test('resolves explicit execroot-relative paths against the injected cwd', () => {
    const root = makeDirectory();
    const parsed = parseOutputArguments(
      [
        '--openapi=out/openapi.v2.json',
        '--events=out/events.schema.json',
        '--typescript=out/contracts.ts',
        '--swift=out/ColorfulCodeContracts.swift',
      ],
      root,
    );

    expect(parsed).toEqual(outputPaths(join(root, 'out')));
  });

  test.each([
    {
      name: 'missing',
      markers: ['missing-secret'],
      args: [
        '--openapi=o/missing-secret/openapi.v2.json',
        '--events=o/events.schema.json',
        '--typescript=o/contracts.ts',
      ],
    },
    {
      name: 'duplicate',
      markers: ['duplicate-secret'],
      args: [
        '--openapi=o/openapi.v2.json',
        '--openapi=x/duplicate-secret/openapi.v2.json',
        '--events=o/events.schema.json',
        '--typescript=o/contracts.ts',
        '--swift=o/ColorfulCodeContracts.swift',
      ],
    },
    {
      name: 'unknown',
      markers: ['unknown-secret'],
      args: [
        '--openapi=o/openapi.v2.json',
        '--events=o/events.schema.json',
        '--typescript=o/contracts.ts',
        '--swift=o/ColorfulCodeContracts.swift',
        '--unknown-secret=payload',
      ],
    },
    {
      name: 'empty',
      markers: ['empty-secret'],
      args: [
        '--openapi=',
        '--events=o/empty-secret/events.schema.json',
        '--typescript=o/contracts.ts',
        '--swift=o/ColorfulCodeContracts.swift',
      ],
    },
  ])('rejects $name arguments without echoing markers', ({ args, markers }) => {
    try {
      parseOutputArguments(args, makeDirectory());
      throw new Error('expected argument validation to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(TypeError);
      for (const marker of markers) {
        expect(String(error)).not.toContain(marker);
      }
    }
  });

  test.each(['events', 'typescript', 'swift', 'openapi'] as const)(
    'rejects a resolved path collision involving %s as a unique-path error',
    (collidingOutput) => {
      const root = makeDirectory();
      const paths = {
        openapi: 'out/openapi.v2.json',
        events: 'out/events.schema.json',
        typescript: 'out/contracts.ts',
        swift: 'out/ColorfulCodeContracts.swift',
      };
      const counterpart = collidingOutput === 'openapi' ? 'events' : 'openapi';
      paths[collidingOutput] = paths[counterpart];

      expect(() =>
        parseOutputArguments(
          [
            `--openapi=${paths.openapi}`,
            `--events=${paths.events}`,
            `--typescript=${paths.typescript}`,
            `--swift=${paths.swift}`,
          ],
          root,
        ),
      ).toThrow(/unique/u);
    },
  );

  test.each([
    'out/../openapi.v2.json',
    'out/./openapi.v2.json',
    'out//openapi.v2.json',
    'out\\openapi.v2.json',
    'out/\0/openapi.v2.json',
  ])('rejects unsafe path %s', (unsafePath) => {
    expect(() =>
      parseOutputArguments(
        [
          `--openapi=${unsafePath}`,
          '--events=out/events.schema.json',
          '--typescript=out/contracts.ts',
          '--swift=out/ColorfulCodeContracts.swift',
        ],
        makeDirectory(),
      ),
    ).toThrow(TypeError);
  });

  test('rejects a basename that does not match its logical output', () => {
    expect(() =>
      parseOutputArguments(
        [
          '--openapi=out/not-openapi.json',
          '--events=out/events.schema.json',
          '--typescript=out/contracts.ts',
          '--swift=out/ColorfulCodeContracts.swift',
        ],
        makeDirectory(),
      ),
    ).toThrow(TypeError);
  });
});

describe('runBazelCodegen', () => {
  test('writes all four declaration outputs byte-for-byte', () => {
    const root = makeDirectory();
    const paths = outputPaths(root);
    runBazelCodegen(argumentsFor(paths));
    const expected = createContractOutputs();

    expect(readFileSync(paths.openapi, 'utf8')).toBe(
      expected['generated/openapi.v2.json'],
    );
    expect(readFileSync(paths.events, 'utf8')).toBe(
      expected['generated/events.schema.json'],
    );
    expect(readFileSync(paths.typescript, 'utf8')).toBe(
      expected['generated/typescript/contracts.ts'],
    );
    expect(readFileSync(paths.swift, 'utf8')).toBe(
      expected[
        'swift-fixture/Sources/ColorfulCodeContracts/ColorfulCodeContracts.swift'
      ],
    );
    for (const path of Object.values(paths)) {
      expect(lstatSync(path).mode & 0o777).toBe(0o600);
    }
  });

  test('rejects a symlink parent and creates no output', () => {
    const root = makeDirectory();
    const realParent = join(root, 'real');
    const linkedParent = join(root, 'linked');
    mkdirSync(realParent);
    symlinkSync(realParent, linkedParent);
    const paths = outputPaths(linkedParent);

    expect(() => runBazelCodegen(argumentsFor(paths))).toThrow();
    expect(Object.values(paths).some(existsSync)).toBe(false);
  });

  test('rejects an existing symlink target without changing its referent', () => {
    const root = makeDirectory();
    const paths = outputPaths(root);
    const referent = join(root, 'referent');
    writeFileSync(referent, 'keep');
    symlinkSync(referent, paths.openapi);

    expect(() => runBazelCodegen(argumentsFor(paths))).toThrow();
    expect(readFileSync(referent, 'utf8')).toBe('keep');
    expect(lstatSync(paths.openapi).isSymbolicLink()).toBe(true);
  });

  test('does not overwrite an existing target', () => {
    const root = makeDirectory();
    const paths = outputPaths(root);
    writeFileSync(paths.events, 'keep');

    expect(() => runBazelCodegen(argumentsFor(paths))).toThrow();
    expect(readFileSync(paths.events, 'utf8')).toBe('keep');
    expect(existsSync(paths.openapi)).toBe(false);
  });

  test('validates every output before the first write', () => {
    const root = makeDirectory();
    const paths = outputPaths(root);
    const args = [...argumentsFor(paths)];
    args[3] = `--swift=${root}/unsafe/../ColorfulCodeContracts.swift`;

    expect(() => runBazelCodegen(args)).toThrow(TypeError);
    expect(Object.values(paths).some(existsSync)).toBe(false);
  });

  test('leaves earlier outputs in place after a later write failure', () => {
    const root = makeDirectory();
    const paths = outputPaths(root);
    let writeCount = 0;
    let failedDescriptor: number | undefined;

    expect(() =>
      bazelRunnerTestSeams.runBazelCodegenWithWriter(
        argumentsFor(paths),
        (descriptor, contents) => {
          writeCount += 1;
          if (writeCount === 4) {
            failedDescriptor = descriptor;
            throw new Error('simulated write failure');
          }
          writeFileSync(descriptor, contents);
        },
      ),
    ).toThrow('simulated write failure');
    expect(existsSync(paths.openapi)).toBe(true);
    expect(existsSync(paths.events)).toBe(true);
    expect(existsSync(paths.typescript)).toBe(true);
    expect(existsSync(paths.swift)).toBe(true);
    expect(() => fstatSync(failedDescriptor!)).toThrow();
  });

  test('source stays within the Bazel runner dependency boundary', () => {
    const source = readFileSync(
      resolve(import.meta.dir, '../scripts/bazel-runner.ts'),
      'utf8',
    );

    expect(source).not.toMatch(
      /\b(?:from\s+|import\s*(?:\(\s*)?)['"](?:[^'"]*\/)?generate\.(?:ts|js)['"]|bun:ffi/u,
    );
    expect(source).not.toMatch(
      /\b(?:publisher|lock|journal|temp|staging|quarantine|backup|hostname|Date|performance|random)\b|Math\.random|randomUUID|getRandomValues|process\.pid/u,
    );
  });

  test('bundled Node 22 CLI exits non-zero with a bounded diagnostic', async () => {
    const script = resolve(import.meta.dir, '../scripts/bazel-runner.ts');
    const root = makeDirectory();
    const build = await Bun.build({
      entrypoints: [script],
      format: 'esm',
      naming: '[name].mjs',
      outdir: root,
      target: 'node',
    });
    expect(build.success).toBe(true);
    const nodeVersion = Bun.spawnSync(['node', '--version'], {
      stderr: 'pipe',
      stdout: 'pipe',
    });
    expect(nodeVersion.exitCode).toBe(0);
    expect(nodeVersion.stdout.toString()).toMatch(/^v22\./u);

    const result = Bun.spawnSync(['node', join(root, 'bazel-runner.mjs')], {
      stderr: 'pipe',
      stdout: 'pipe',
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout.toString()).toBe('');
    expect(result.stderr.toString()).toMatch(/^TypeError: [^\n]+\n$/u);
  });
});
