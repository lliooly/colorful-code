import {
  closeSync,
  lstatSync,
  mkdirSync,
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

import { createContractOutputs } from '../scripts/create-contract-outputs.js';

const OUTPUT_NAMES = ['openapi', 'events', 'typescript', 'swift'] as const;

type OutputName = (typeof OUTPUT_NAMES)[number];

export type BazelOutputPaths = Readonly<Record<OutputName, string>>;

class BazelRunnerDiagnosticError extends TypeError {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'TypeError';
  }
}

const diagnosticError = (
  message: string,
  cause?: unknown,
): BazelRunnerDiagnosticError => new BazelRunnerDiagnosticError(message, cause);

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
    throw diagnosticError('invalid Bazel output path');
  }

  const pathWithoutRoot = isAbsolute(value) ? value.slice(1) : value;
  const segments = pathWithoutRoot.split('/');
  if (
    segments.some(
      (segment) => segment.length === 0 || segment === '.' || segment === '..',
    )
  ) {
    throw diagnosticError('invalid Bazel output path');
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
      throw diagnosticError('unknown Bazel output argument');
    }
    if (value === undefined || value.length === 0) {
      throw diagnosticError('empty Bazel output argument');
    }
    if (parsed[name] !== undefined) {
      throw diagnosticError('duplicate Bazel output argument');
    }

    parsed[name] = resolveActionPath(value, cwd);
  }

  if (OUTPUT_NAMES.some((name) => parsed[name] === undefined)) {
    throw diagnosticError('missing Bazel output argument');
  }

  const paths = parsed as Record<OutputName, string>;
  if (new Set(Object.values(paths)).size !== OUTPUT_NAMES.length) {
    throw diagnosticError('Bazel output paths must be unique');
  }
  for (const name of OUTPUT_NAMES) {
    if (basename(paths[name]) !== expectedBasenameByOutput[name]) {
      throw diagnosticError('incorrect Bazel output basename');
    }
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
    throw diagnosticError('failed to inspect Bazel output', error);
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
    throw diagnosticError('Bazel output parent is not a real directory');
  }

  for (const segment of relativeSegments) {
    current = join(current, segment);
    const stats = lstatIfPresent(current);
    if (stats === undefined) {
      try {
        mkdirSync(current, 0o755);
      } catch (error) {
        if (lstatIfPresent(current) === undefined) {
          throw diagnosticError(
            'Bazel output parent is not a real directory',
            error,
          );
        }
      }
    }
    const currentStats = lstatIfPresent(current);
    if (
      currentStats === undefined ||
      !currentStats.isDirectory() ||
      currentStats.isSymbolicLink()
    ) {
      throw diagnosticError('Bazel output parent is not a real directory');
    }
  }
};

const validateOutputTarget = (outputPath: string): void => {
  validateParentDirectories(outputPath);
  if (lstatIfPresent(outputPath) !== undefined) {
    throw diagnosticError('Bazel output target already exists');
  }
};

type DescriptorWriter = (descriptor: number, contents: string) => void;

const writeOutput = (
  path: string,
  contents: string,
  writer: DescriptorWriter,
): void => {
  let descriptor: number;
  try {
    descriptor = openSync(path, 'wx', 0o600);
  } catch (error) {
    throw diagnosticError('failed to write Bazel output', error);
  }

  let writerFailed = false;
  let writerFailure: unknown;
  try {
    writer(descriptor, contents);
  } catch (error) {
    writerFailed = true;
    writerFailure = error;
  }

  let closeFailed = false;
  let closeFailure: unknown;
  try {
    closeSync(descriptor);
  } catch (error) {
    closeFailed = true;
    closeFailure = error;
  }

  if (writerFailed) {
    throw diagnosticError('failed to write Bazel output', writerFailure);
  }
  if (closeFailed) {
    throw diagnosticError('failed to close Bazel output', closeFailure);
  }
};

const runBazelCodegenWithWriter = (
  args: readonly string[],
  writer: DescriptorWriter,
): void => {
  const paths = parseOutputArguments(args);
  for (const name of OUTPUT_NAMES) validateOutputTarget(paths[name]);

  let outputs: ReturnType<typeof createContractOutputs>;
  try {
    outputs = createContractOutputs();
  } catch (error) {
    throw diagnosticError('contract generation failed', error);
  }
  for (const name of OUTPUT_NAMES) {
    writeOutput(paths[name], outputs[generatedPathByOutput[name]], writer);
  }
};

export const runBazelCodegen = (
  args: readonly string[] = process.argv.slice(2),
): void => runBazelCodegenWithWriter(args, writeFileSync);

const formatCliDiagnostic = (error: unknown): string =>
  error instanceof BazelRunnerDiagnosticError
    ? `${error.name}: ${error.message}`
    : 'Error: Bazel code generation failed';

export const bazelRunnerTestSeams = Object.freeze({
  formatCliDiagnostic,
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
    console.error(formatCliDiagnostic(error));
    process.exitCode = 1;
  }
}
