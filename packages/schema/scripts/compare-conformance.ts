/// <reference types="node" />

import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdtempSync,
  openSync,
  realpathSync,
  renameSync,
  rmSync,
  rmdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { dlopen, FFIType } from 'bun:ffi';

import {
  compareConformanceRecords,
  readConformanceJsonLines,
} from './lib/conformance-jsonl.js';

const packageRoot = resolve(import.meta.dir, '..');
const swiftPackageRoot = join(packageRoot, 'swift-fixture');
const typeScriptRunner = join(import.meta.dir, 'write-conformance-jsonl.ts');

const libcPath =
  process.platform === 'darwin'
    ? '/usr/lib/libSystem.B.dylib'
    : process.platform === 'linux'
      ? 'libc.so.6'
      : undefined;
if (libcPath === undefined) {
  throw new Error('cross-language cleanup requires Darwin or Linux');
}
const cleanupLibrary = dlopen(libcPath, {
  fchdir: { args: [FFIType.i32], returns: FFIType.i32 },
});
const fchdir = cleanupLibrary.symbols.fchdir;

export type ConformanceCommandExecutor = (command: readonly string[]) => number;

export const runConformanceCommands = (
  commands: readonly (readonly string[])[],
  execute: ConformanceCommandExecutor,
): void => {
  for (const command of commands) {
    if (
      command.length === 0 ||
      command.some((argument) => argument.length === 0)
    ) {
      throw new TypeError('conformance command failed');
    }
    if (execute(command) !== 0) {
      throw new TypeError('conformance command failed');
    }
  }
};

const executeConformanceCommand: ConformanceCommandExecutor = (command) => {
  const outputRootIndex = command.indexOf('--output-root');
  const outputRoot = command[outputRootIndex + 1];
  const scratchPathIndex = command.indexOf('--scratch-path');
  const scratchPath = command[scratchPathIndex + 1];
  const moduleCache =
    scratchPathIndex >= 0 && scratchPath !== undefined
      ? join(scratchPath, '.swift-module-cache')
      : outputRootIndex >= 0 && outputRoot !== undefined
        ? join(outputRoot, '.swift-module-cache')
        : undefined;
  const result = Bun.spawnSync([...command], {
    cwd: packageRoot,
    env:
      moduleCache === undefined
        ? process.env
        : {
            ...process.env,
            CLANG_MODULE_CACHE_PATH: moduleCache,
            SWIFTPM_MODULECACHE_OVERRIDE: moduleCache,
          },
    stderr: 'ignore',
    stdout: 'ignore',
  });
  return result.exitCode;
};

type CrossLanguageOptions = Readonly<{
  fixtureRoot: string;
  swiftOnly?: boolean;
}>;

const conformanceCommands = (
  fixtureRoot: string,
  outputRoot: string,
): Readonly<{
  swift: readonly string[];
  swiftBuild: readonly string[];
  swiftTest: readonly string[];
  typescript: readonly string[];
}> => {
  const scratchPath = join(outputRoot, '.swift-build');
  const executable = join(scratchPath, 'debug', 'ColorfulCodeConformance');
  return Object.freeze({
    typescript: Object.freeze([
      process.execPath,
      typeScriptRunner,
      '--fixture-root',
      fixtureRoot,
      '--output-root',
      outputRoot,
      '--output-name',
      'typescript.jsonl',
    ]),
    swift: Object.freeze([
      'swift',
      'run',
      '--package-path',
      swiftPackageRoot,
      '--scratch-path',
      scratchPath,
      'ColorfulCodeConformance',
      '--fixture-root',
      fixtureRoot,
      '--output-root',
      outputRoot,
      '--output-name',
      'swift.jsonl',
    ]),
    swiftBuild: Object.freeze([
      'swift',
      'build',
      '--package-path',
      swiftPackageRoot,
      '--scratch-path',
      scratchPath,
      '--product',
      'ColorfulCodeConformance',
    ]),
    swiftTest: Object.freeze([
      '/usr/bin/env',
      `SCHEMA_GOLDEN_FIXTURE_ROOT=${fixtureRoot}`,
      `SCHEMA_CONFORMANCE_EXECUTABLE=${executable}`,
      'swift',
      'test',
      '--package-path',
      swiftPackageRoot,
      '--scratch-path',
      scratchPath,
    ]),
  });
};

export const runCrossLanguageConformance = (
  options: CrossLanguageOptions,
  execute: ConformanceCommandExecutor = executeConformanceCommand,
): void => {
  const fixtureRoot = resolve(options.fixtureRoot);
  withConformanceWorkspace((outputRoot) => {
    const commands = conformanceCommands(fixtureRoot, outputRoot);
    if (options.swiftOnly === true) {
      runConformanceCommands(
        [commands.swiftBuild, commands.swiftTest, commands.swift],
        execute,
      );
      readConformanceJsonLines(outputRoot, 'swift.jsonl');
      return;
    }
    runConformanceCommands([commands.typescript, commands.swift], execute);
    compareConformanceFiles(outputRoot, 'typescript.jsonl', 'swift.jsonl');
  });
};

export const compareConformanceFiles = (
  outputRoot: string,
  typescriptName: string,
  swiftName: string,
): void => {
  const typescript = readConformanceJsonLines(outputRoot, typescriptName);
  const swift = readConformanceJsonLines(outputRoot, swiftName);
  compareConformanceRecords(typescript, swift);
};

export type ConformanceWorkspaceHooks = Readonly<{
  beforeWorkspaceRemoval?: (cleanupRoot: string) => void;
}>;

const cleanupDirectoryFlags = (): number => {
  let flags = constants.O_RDONLY;
  for (const name of ['O_DIRECTORY', 'O_NOFOLLOW', 'O_CLOEXEC']) {
    const flag = Reflect.get(constants, name);
    if (typeof flag === 'number') flags |= flag;
  }
  return flags;
};

const sameWorkspaceIdentity = (
  left: ReturnType<typeof lstatSync>,
  right: ReturnType<typeof lstatSync>,
): boolean =>
  right.isDirectory() &&
  !right.isSymbolicLink() &&
  right.dev === left.dev &&
  right.ino === left.ino &&
  right.uid === left.uid &&
  right.mode === left.mode;

const removePinnedWorkspace = (
  cleanupRoot: string,
  identity: ReturnType<typeof lstatSync>,
  hooks: ConformanceWorkspaceHooks,
): void => {
  const original = openSync('.', cleanupDirectoryFlags());
  let cleanup: number | undefined;
  let entered = false;
  let restored = false;
  try {
    cleanup = openSync(cleanupRoot, cleanupDirectoryFlags());
    if (
      !sameWorkspaceIdentity(identity, fstatSync(cleanup)) ||
      !sameWorkspaceIdentity(identity, lstatSync(cleanupRoot)) ||
      realpathSync(cleanupRoot) !== cleanupRoot ||
      fchdir(cleanup) !== 0
    ) {
      throw new TypeError('conformance workspace changed');
    }
    entered = true;
    if (!sameWorkspaceIdentity(identity, lstatSync('.'))) {
      throw new TypeError('conformance workspace changed');
    }
    hooks.beforeWorkspaceRemoval?.(cleanupRoot);
    rmSync('workspace', { force: true, recursive: true });
  } finally {
    if (entered) restored = fchdir(original) === 0;
    if (cleanup !== undefined) closeSync(cleanup);
    closeSync(original);
  }
  if (!restored) throw new TypeError('conformance workspace changed');
  const current = lstatSync(cleanupRoot);
  if (
    !sameWorkspaceIdentity(identity, current) ||
    realpathSync(cleanupRoot) !== cleanupRoot
  ) {
    throw new TypeError('conformance workspace changed');
  }
  rmdirSync(cleanupRoot);
};

export const withConformanceWorkspace = <T>(
  operation: (root: string) => T,
  hooks: ConformanceWorkspaceHooks = {},
): T => {
  const created = mkdtempSync(join(tmpdir(), 'schema-cross-language-'));
  chmodSync(created, 0o700);
  const root = realpathSync(created);
  const identity = lstatSync(root);
  let outcome:
    | Readonly<{ ok: true; value: T }>
    | Readonly<{ error: unknown; ok: false }>;
  try {
    outcome = Object.freeze({ ok: true, value: operation(root) });
  } catch (error) {
    outcome = Object.freeze({ error, ok: false });
  }
  let cleanupFailed = false;
  let cleanupRoot: string | undefined;
  try {
    const cleanupCreated = mkdtempSync(
      join(tmpdir(), 'schema-cross-language-clean-'),
    );
    chmodSync(cleanupCreated, 0o700);
    cleanupRoot = realpathSync(cleanupCreated);
    const cleanupIdentity = lstatSync(cleanupRoot);
    const detached = join(cleanupRoot, 'workspace');
    renameSync(root, detached);
    const current = lstatSync(detached);
    if (
      !current.isDirectory() ||
      current.isSymbolicLink() ||
      current.dev !== identity.dev ||
      current.ino !== identity.ino ||
      current.uid !== identity.uid ||
      current.mode !== identity.mode ||
      realpathSync(detached) !== detached
    ) {
      cleanupFailed = true;
      if (lstatSync(root, { throwIfNoEntry: false }) === undefined) {
        renameSync(detached, root);
      }
      rmdirSync(cleanupRoot);
      cleanupRoot = undefined;
    } else {
      removePinnedWorkspace(cleanupRoot, cleanupIdentity, hooks);
      cleanupRoot = undefined;
    }
  } catch {
    cleanupFailed = true;
  }
  if (cleanupFailed) throw new TypeError('conformance workspace changed');
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
};

const commandLineOptions = (args: readonly string[]): CrossLanguageOptions => {
  let fixtureRoot: string | undefined;
  let swiftOnly = false;
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === '--swift-only' && !swiftOnly) {
      swiftOnly = true;
      continue;
    }
    if (flag === '--fixture-root' && fixtureRoot === undefined) {
      fixtureRoot = args[index + 1];
      if (fixtureRoot === undefined || fixtureRoot.length === 0) {
        throw new TypeError('invalid arguments');
      }
      index += 1;
      continue;
    }
    throw new TypeError('invalid arguments');
  }
  if (fixtureRoot === undefined) throw new TypeError('invalid arguments');
  return Object.freeze({ fixtureRoot, swiftOnly });
};

if (import.meta.main) {
  try {
    runCrossLanguageConformance(commandLineOptions(process.argv.slice(2)));
  } catch {
    console.error('cross-language conformance failed');
    process.exitCode = 1;
  }
}
