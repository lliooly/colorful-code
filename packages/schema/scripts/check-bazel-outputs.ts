import { existsSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';

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
    if (basename(outputs[name]!) !== expectedBasename[name]) {
      return 'output set has unexpected relative path';
    }
  }
  return undefined;
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
    if (!existsSync(output)) {
      return {
        ok: false,
        diagnostic: outputDiagnostic(name, output, 'missing output'),
      };
    }
    if (!existsSync(fixture)) {
      return {
        ok: false,
        diagnostic: `${name}: missing fixture ${basename(fixture)}`,
      };
    }
    let outputBytes: Buffer;
    let fixtureBytes: Buffer;
    try {
      outputBytes = readFileSync(output);
      fixtureBytes = readFileSync(fixture);
    } catch {
      return {
        ok: false,
        diagnostic: `${name}: unable to read ${basename(output)}`,
      };
    }
    if (!outputBytes.equals(fixtureBytes)) {
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
