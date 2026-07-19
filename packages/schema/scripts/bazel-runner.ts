import {
  closeSync,
  lstatSync,
  openSync,
  writeFileSync,
  type Stats,
} from 'node:fs';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  parse,
  resolve,
  sep,
} from 'node:path';
import { pathToFileURL } from 'node:url';

import { createContractOutputs } from './create-contract-outputs.js';

const OUTPUT_NAMES = ['openapi', 'events', 'typescript', 'swift'] as const;

type OutputName = (typeof OUTPUT_NAMES)[number];

export type BazelOutputPaths = Readonly<Record<OutputName, string>>;

const expectedBasenameByOutput = Object.freeze({
  openapi: 'openapi.v2.json',
  events: 'events.schema.json',
  typescript: 'contracts.ts',
  swift: 'ColorfulCodeContracts.swift',
} satisfies Record<OutputName, string>);

const generatedPathByOutput = Object.freeze({
  openapi: 'generated/openapi.v2.json',
  events: 'generated/events.schema.json',
  typescript: 'generated/typescript/contracts.ts',
  swift:
    'swift-fixture/Sources/ColorfulCodeContracts/ColorfulCodeContracts.swift',
} as const);

const isOutputName = (value: string): value is OutputName =>
  (OUTPUT_NAMES as readonly string[]).includes(value);

const resolveActionPath = (value: string, cwd: string): string => {
  if (
    value.length === 0 ||
    value.includes('\0') ||
    value.includes('\\') ||
    value.includes('//')
  ) {
    throw new TypeError('invalid Bazel output path');
  }

  const pathWithoutRoot = isAbsolute(value) ? value.slice(1) : value;
  const segments = pathWithoutRoot.split('/');
  if (
    segments.some(
      (segment) => segment.length === 0 || segment === '.' || segment === '..',
    )
  ) {
    throw new TypeError('invalid Bazel output path');
  }

  return isAbsolute(value) ? resolve(value) : resolve(cwd, value);
};

export const parseOutputArguments = (
  args: readonly string[],
  cwd = process.cwd(),
): BazelOutputPaths => {
  const parsed: Partial<Record<OutputName, string>> = {};

  for (const argument of args) {
    const separatorIndex = argument.indexOf('=');
    const option =
      separatorIndex === -1 ? argument : argument.slice(0, separatorIndex);
    const value =
      separatorIndex === -1 ? undefined : argument.slice(separatorIndex + 1);
    const name = option.startsWith('--') ? option.slice(2) : '';

    if (!isOutputName(name)) {
      throw new TypeError('unknown Bazel output argument');
    }
    if (value === undefined || value.length === 0) {
      throw new TypeError('empty Bazel output argument');
    }
    if (parsed[name] !== undefined) {
      throw new TypeError('duplicate Bazel output argument');
    }

    const outputPath = resolveActionPath(value, cwd);
    if (basename(outputPath) !== expectedBasenameByOutput[name]) {
      throw new TypeError('incorrect Bazel output basename');
    }
    parsed[name] = outputPath;
  }

  if (OUTPUT_NAMES.some((name) => parsed[name] === undefined)) {
    throw new TypeError('missing Bazel output argument');
  }

  const paths = parsed as Record<OutputName, string>;
  if (new Set(Object.values(paths)).size !== OUTPUT_NAMES.length) {
    throw new TypeError('Bazel output paths must be unique');
  }

  return Object.freeze({
    openapi: paths.openapi,
    events: paths.events,
    typescript: paths.typescript,
    swift: paths.swift,
  });
};

const lstatIfPresent = (path: string): Stats | undefined => {
  try {
    return lstatSync(path);
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      return undefined;
    }
    throw error;
  }
};

const validateParentDirectories = (outputPath: string): void => {
  const parent = dirname(outputPath);
  const root = parse(parent).root;
  const relativeSegments = parent.slice(root.length).split(sep).filter(Boolean);
  let current = root;

  const rootStats = lstatIfPresent(root);
  if (
    rootStats === undefined ||
    !rootStats.isDirectory() ||
    rootStats.isSymbolicLink()
  ) {
    throw new TypeError('Bazel output parent is not a real directory');
  }

  for (const segment of relativeSegments) {
    current = join(current, segment);
    const stats = lstatIfPresent(current);
    if (stats === undefined || !stats.isDirectory() || stats.isSymbolicLink()) {
      throw new TypeError('Bazel output parent is not a real directory');
    }
  }
};

const validateOutputTarget = (outputPath: string): void => {
  validateParentDirectories(outputPath);
  if (lstatIfPresent(outputPath) !== undefined) {
    throw new TypeError('Bazel output target already exists');
  }
};

type DescriptorWriter = (descriptor: number, contents: string) => void;

const runBazelCodegenWithWriter = (
  args: readonly string[],
  writer: DescriptorWriter,
): void => {
  const paths = parseOutputArguments(args);
  for (const name of OUTPUT_NAMES) validateOutputTarget(paths[name]);

  const outputs = createContractOutputs();
  for (const name of OUTPUT_NAMES) {
    const path = paths[name];
    const descriptor = openSync(path, 'wx', 0o600);
    try {
      writer(descriptor, outputs[generatedPathByOutput[name]]);
    } finally {
      closeSync(descriptor);
    }
  }
};

export const runBazelCodegen = (
  args: readonly string[] = process.argv.slice(2),
): void => runBazelCodegenWithWriter(args, writeFileSync);

export const bazelRunnerTestSeams = Object.freeze({
  runBazelCodegenWithWriter,
});

const isMainModule = (): boolean => {
  const entryPath = process.argv[1];
  return (
    entryPath !== undefined &&
    pathToFileURL(resolve(entryPath)).href === import.meta.url
  );
};

if (isMainModule()) {
  try {
    runBazelCodegen();
  } catch (error) {
    const name = error instanceof Error ? error.name : 'Error';
    const message =
      error instanceof Error ? error.message : 'Bazel code generation failed';
    console.error(`${name}: ${message}`);
    process.exitCode = 1;
  }
}
