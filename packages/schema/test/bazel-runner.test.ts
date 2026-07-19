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
      args: [
        '--openapi=o/openapi.v2.json',
        '--events=o/events.schema.json',
        '--typescript=o/contracts.ts',
      ],
    },
    {
      name: 'duplicate',
      args: [
        '--openapi=o/openapi.v2.json',
        '--openapi=x/openapi.v2.json',
        '--events=o/events.schema.json',
        '--typescript=o/contracts.ts',
        '--swift=o/ColorfulCodeContracts.swift',
      ],
    },
    {
      name: 'unknown',
      args: [
        '--openapi=o/openapi.v2.json',
        '--events=o/events.schema.json',
        '--typescript=o/contracts.ts',
        '--swift=o/ColorfulCodeContracts.swift',
        '--extra=secret-payload',
      ],
    },
    {
      name: 'empty',
      args: [
        '--openapi=',
        '--events=o/events.schema.json',
        '--typescript=o/contracts.ts',
        '--swift=o/ColorfulCodeContracts.swift',
      ],
    },
  ])('rejects $name arguments without echoing argv', ({ args }) => {
    try {
      parseOutputArguments(args, makeDirectory());
      throw new Error('expected argument validation to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(TypeError);
      expect(String(error)).not.toContain('secret-payload');
      expect(String(error)).not.toContain(args.join(' '));
    }
  });

  test('rejects distinct logical outputs that resolve to the same path', () => {
    const root = makeDirectory();
    expect(() =>
      parseOutputArguments(
        [
          '--openapi=out/openapi.v2.json',
          '--events=out/openapi.v2.json',
          '--typescript=out/contracts.ts',
          '--swift=out/ColorfulCodeContracts.swift',
        ],
        root,
      ),
    ).toThrow(TypeError);
  });

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

    expect(source).not.toMatch(/bun:|generate\.js|publisher|lock|journal/u);
    expect(source).not.toMatch(/hostname|Date|performance|random|randomUUID/u);
    expect(source).not.toMatch(/process\.pid/u);
  });

  test('CLI exits non-zero and prints only a bounded diagnostic', () => {
    const script = resolve(import.meta.dir, '../scripts/bazel-runner.ts');
    const result = Bun.spawnSync(['bun', script], {
      stderr: 'pipe',
      stdout: 'pipe',
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout.toString()).toBe('');
    expect(result.stderr.toString()).toMatch(/^TypeError: [^\n]+\n$/u);
  });
});
