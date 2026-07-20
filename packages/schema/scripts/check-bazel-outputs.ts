import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
  realpathSync,
  type Stats,
} from 'node:fs';
import { basename, resolve } from 'node:path';

const OUTPUT_NAMES = ['openapi', 'events', 'typescript', 'swift'] as const;
type OutputName = (typeof OUTPUT_NAMES)[number];
type OutputPaths = Readonly<Record<OutputName, string>>;

const expectedBasename = Object.freeze({
  openapi: 'openapi.v2.json',
  events: 'events.schema.json',
  typescript: 'contracts.ts',
  swift: 'ColorfulCodeContracts.swift',
} satisfies Record<OutputName, string>);

const outputDiagnostic = (
  name: OutputName,
  path: string,
  reason: 'missing output' | 'content differs',
): string => `${name}: ${reason} ${basename(path)}`;

const validateOutputSet = (
  outputs: Readonly<Record<string, string>>,
  fixtures: Readonly<Record<string, string>>,
): string | undefined => {
  if (Object.keys(outputs).length !== OUTPUT_NAMES.length) {
    return 'output count must be exactly four';
  }
  if (Object.keys(fixtures).length !== OUTPUT_NAMES.length) {
    return 'fixture count must be exactly four';
  }
  for (const name of OUTPUT_NAMES) {
    if (!(name in outputs) || !(name in fixtures)) {
      return 'output set has unexpected logical names';
    }
    if (
      basename(outputs[name]!) !== expectedBasename[name] ||
      basename(fixtures[name]!) !== expectedBasename[name]
    ) {
      return 'output set has unexpected relative path';
    }
  }
  const allPaths = OUTPUT_NAMES.reduce<string[]>(
    (paths, name) => paths.concat(outputs[name]!, fixtures[name]!),
    [],
  );
  if (new Set(allPaths.map((path) => resolve(path))).size !== allPaths.length) {
    return 'output and fixture paths must be distinct';
  }
  return undefined;
};

const readRegularFile = (
  path: string,
):
  | { kind: 'ok'; bytes: Buffer; dev: number; ino: number }
  | { kind: 'missing' | 'unreadable' } => {
  try {
    realpathSync(path);
  } catch (error) {
    return {
      kind:
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'ENOENT'
          ? 'missing'
          : 'unreadable',
    };
  }
  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY);
  } catch (error) {
    return {
      kind:
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'ENOENT'
          ? 'missing'
          : 'unreadable',
    };
  }
  let result:
    | { kind: 'ok'; bytes: Buffer; dev: number; ino: number }
    | { kind: 'unreadable' };
  try {
    const stats: Stats = fstatSync(descriptor);
    result = !stats.isFile()
      ? { kind: 'unreadable' }
      : {
          kind: 'ok',
          bytes: readFileSync(descriptor),
          dev: stats.dev,
          ino: stats.ino,
        };
  } catch {
    result = { kind: 'unreadable' };
  }
  try {
    closeSync(descriptor);
  } catch {
    return { kind: 'unreadable' };
  }
  return result;
};

export type BazelOutputCheckResult =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; diagnostic: string }>;

export const checkBazelOutputs = (
  outputs: OutputPaths,
  fixtures: OutputPaths,
): BazelOutputCheckResult => {
  const invalidSet = validateOutputSet(outputs, fixtures);
  if (invalidSet !== undefined) return { ok: false, diagnostic: invalidSet };

  for (const name of OUTPUT_NAMES) {
    const output = outputs[name];
    const fixture = fixtures[name];
    const outputFile = readRegularFile(output);
    if (outputFile.kind === 'missing') {
      return {
        ok: false,
        diagnostic: outputDiagnostic(name, output, 'missing output'),
      };
    }
    if (outputFile.kind !== 'ok') {
      return {
        ok: false,
        diagnostic: `${name}: unable to read ${basename(output)}`,
      };
    }
    const fixtureFile = readRegularFile(fixture);
    if (fixtureFile.kind === 'missing') {
      return {
        ok: false,
        diagnostic: `${name}: missing fixture ${basename(fixture)}`,
      };
    }
    if (fixtureFile.kind !== 'ok') {
      return {
        ok: false,
        diagnostic: `${name}: unable to read ${basename(fixture)}`,
      };
    }
    if (
      outputFile.dev === fixtureFile.dev &&
      outputFile.ino === fixtureFile.ino
    ) {
      return {
        ok: false,
        diagnostic: 'output and fixture paths must be distinct',
      };
    }
    if (!outputFile.bytes.equals(fixtureFile.bytes)) {
      return {
        ok: false,
        diagnostic: outputDiagnostic(name, output, 'content differs'),
      };
    }
  }
  return { ok: true };
};

const parseArguments = (
  args: readonly string[],
): {
  outputs: OutputPaths;
  fixtures: OutputPaths;
} => {
  const parsed = new Map<string, string>();
  for (const argument of args) {
    const equals = argument.indexOf('=');
    const key = equals >= 0 ? argument.slice(0, equals) : '';
    const value = equals >= 0 ? argument.slice(equals + 1) : '';
    if (!key.startsWith('--') || value.length === 0 || parsed.has(key)) {
      throw new TypeError('invalid Bazel output checker arguments');
    }
    parsed.set(key, value);
  }
  const outputs = Object.fromEntries(
    OUTPUT_NAMES.map((name) => {
      const value = parsed.get(`--${name}`);
      if (value === undefined)
        throw new TypeError('missing Bazel output checker argument');
      return [name, value];
    }),
  ) as OutputPaths;
  const fixtures = Object.fromEntries(
    OUTPUT_NAMES.map((name) => {
      const value = parsed.get(`--fixture-${name}`);
      if (value === undefined)
        throw new TypeError('missing Bazel fixture checker argument');
      return [name, value];
    }),
  ) as OutputPaths;
  if (parsed.size !== OUTPUT_NAMES.length * 2) {
    throw new TypeError('unknown Bazel output checker argument');
  }
  return { outputs, fixtures };
};

export const bazelOutputCheckerTestSeams = Object.freeze({
  validateOutputSet,
  parseArguments,
});

if (process.argv[1]?.endsWith('check-bazel-outputs.js')) {
  try {
    const { outputs, fixtures } = parseArguments(process.argv.slice(2));
    const result = checkBazelOutputs(outputs, fixtures);
    if (!result.ok) {
      console.error(result.diagnostic);
      process.exitCode = 1;
    }
  } catch {
    console.error('invalid Bazel output checker arguments');
    process.exitCode = 1;
  }
}
