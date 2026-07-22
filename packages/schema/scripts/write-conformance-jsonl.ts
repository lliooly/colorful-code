/// <reference types="node" />

import { runConformanceCatalog } from './lib/conformance.js';
import { writeConformanceJsonLines } from './lib/conformance-jsonl.js';

export type TypeScriptConformanceOptions = Readonly<{
  fixtureRoot: string;
  outputName: string;
  outputRoot: string;
}>;

export const runTypeScriptConformance = (
  options: TypeScriptConformanceOptions,
): string => {
  const report = runConformanceCatalog(options.fixtureRoot);
  return writeConformanceJsonLines(
    options.outputRoot,
    options.outputName,
    report.records,
  );
};

const commandLineOptions = (
  args: readonly string[],
): TypeScriptConformanceOptions => {
  if (args.length !== 6) throw new TypeError('invalid arguments');
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (
      flag === undefined ||
      value === undefined ||
      value.length === 0 ||
      values.has(flag) ||
      !['--fixture-root', '--output-name', '--output-root'].includes(flag)
    ) {
      throw new TypeError('invalid arguments');
    }
    values.set(flag, value);
  }
  const fixtureRoot = values.get('--fixture-root');
  const outputName = values.get('--output-name');
  const outputRoot = values.get('--output-root');
  if (
    fixtureRoot === undefined ||
    outputName === undefined ||
    outputRoot === undefined
  ) {
    throw new TypeError('invalid arguments');
  }
  return Object.freeze({ fixtureRoot, outputName, outputRoot });
};

if (import.meta.main) {
  try {
    runTypeScriptConformance(commandLineOptions(process.argv.slice(2)));
  } catch {
    console.error('typescript conformance failed');
    process.exitCode = 1;
  }
}
