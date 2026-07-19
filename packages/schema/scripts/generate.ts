import { randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { hostname as systemHostname } from 'node:os';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { dlopen, FFIType } from 'bun:ffi';

import { contractRegistry } from '../src/registry.js';
import { createEventsSchema } from './lib/events-schema.js';
import { createJsonSchemaIr } from './lib/json-schema.js';
import { createOpenApiDocument } from './lib/openapi.js';
import { stableJson } from './lib/stable-json.js';
import { createSwiftContracts } from './lib/swift.js';
import { createTypeScriptContracts } from './lib/typescript.js';

const LOCK_NAME = '.schema-generation.lock';
const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const DEFAULT_STALE_LOCK_MS = 30_000;
const LOCK_EXCLUSIVE_NONBLOCKING = 2 | 4;
const LOCK_UNLOCK = 8;

const libcPath =
  process.platform === 'darwin'
    ? '/usr/lib/libSystem.B.dylib'
    : process.platform === 'linux'
      ? 'libc.so.6'
      : undefined;
if (libcPath === undefined) {
  throw new Error(
    'schema generation advisory locking requires Darwin or Linux',
  );
}
const flockLibrary = dlopen(libcPath, {
  flock: {
    args: [FFIType.i32, FFIType.i32],
    returns: FFIType.i32,
  },
});
const flock = flockLibrary.symbols.flock;

export const GENERATED_PATHS = [
  'generated/openapi.v2.json',
  'generated/events.schema.json',
  'generated/typescript/contracts.ts',
  'swift-fixture/Sources/ColorfulCodeContracts/ColorfulCodeContracts.swift',
] as const;

type LockRecord = Readonly<{
  pid: number;
  hostname: string;
  nonce: string;
  createdAt: number;
}>;

export type AtomicDependencies = Readonly<{
  now: () => number;
  monotonicNow: () => number;
  sleep: (milliseconds: number) => Promise<void>;
  pid: number;
  hostname: () => string;
  pidIsAlive: (pid: number) => boolean | undefined;
  nonce: () => string;
  rename: (from: string, to: string) => void;
  tryLock: (descriptor: number) => boolean;
  unlock: (descriptor: number) => void;
  afterLockAcquired: () => Promise<void>;
  afterStaleInspect: () => Promise<void>;
  onLockCollision: () => void;
}>;

export type PublishOptions = Readonly<{
  lockTimeoutMs?: number;
  staleLockMs?: number;
  dependencies?: Partial<AtomicDependencies>;
}>;

const defaultPidIsAlive = (pid: number): boolean | undefined => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    return undefined;
  }
};

const dependencies = (
  overrides: Partial<AtomicDependencies> | undefined,
): AtomicDependencies => ({
  now: Date.now,
  monotonicNow: performance.now.bind(performance),
  sleep: (milliseconds) =>
    new Promise((complete) => setTimeout(complete, milliseconds)),
  pid: process.pid,
  hostname: systemHostname,
  pidIsAlive: defaultPidIsAlive,
  nonce: randomUUID,
  rename: renameSync,
  tryLock: (descriptor) => flock(descriptor, LOCK_EXCLUSIVE_NONBLOCKING) === 0,
  unlock: (descriptor) => {
    if (flock(descriptor, LOCK_UNLOCK) !== 0) {
      throw new Error('failed to release schema generation advisory lock');
    }
  },
  afterLockAcquired: async () => {},
  afterStaleInspect: async () => {},
  onLockCollision: () => {},
  ...overrides,
});

const errno = (error: unknown, code: string): boolean =>
  error instanceof Error && (error as NodeJS.ErrnoException).code === code;

const safeRelativePath = (path: string): readonly string[] => {
  if (path.length === 0 || isAbsolute(path) || path.includes('\\')) {
    throw new TypeError('generated output path must be a relative POSIX path');
  }
  const segments = path.split('/');
  if (
    segments.some(
      (segment) => segment === '' || segment === '.' || segment === '..',
    )
  ) {
    throw new TypeError(
      'generated output path contains an unsafe path segment',
    );
  }
  return segments;
};

const assertRoot = (root: string): void => {
  const metadata = lstatSync(root);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new TypeError('package root must be a real directory');
  }
};

const assertContained = (root: string, candidate: string): void => {
  const offset = relative(root, candidate);
  if (offset === '..' || offset.startsWith(`..${sep}`) || isAbsolute(offset)) {
    throw new TypeError('generated output path escapes package root');
  }
};

const ensureSafeDirectory = (
  root: string,
  segments: readonly string[],
): void => {
  let current = root;
  for (const segment of segments) {
    current = resolve(current, segment);
    assertContained(root, current);
    try {
      const metadata = lstatSync(current);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw new TypeError('generated output parent is not a real directory');
      }
    } catch (error) {
      if (!errno(error, 'ENOENT')) throw error;
      mkdirSync(current, { mode: 0o700 });
      const metadata = lstatSync(current);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw new TypeError('generated output parent changed during creation');
      }
    }
  }
};

const assertSafeFile = (path: string, label: string): void => {
  try {
    const metadata = lstatSync(path);
    if (metadata.isSymbolicLink())
      throw new TypeError(`${label} is a symbolic link`);
    if (!metadata.isFile())
      throw new TypeError(`${label} is not a regular file`);
    if (metadata.nlink !== 1) throw new TypeError(`${label} is a hard link`);
  } catch (error) {
    if (!errno(error, 'ENOENT')) throw error;
  }
};

const parseLock = (source: string): LockRecord | undefined => {
  try {
    const value = JSON.parse(source) as Partial<LockRecord>;
    if (
      value === null ||
      typeof value !== 'object' ||
      !Number.isSafeInteger(value.pid) ||
      (value.pid ?? 0) <= 0 ||
      typeof value.hostname !== 'string' ||
      value.hostname.length === 0 ||
      typeof value.nonce !== 'string' ||
      value.nonce.length === 0 ||
      typeof value.createdAt !== 'number' ||
      !Number.isFinite(value.createdAt)
    ) {
      return undefined;
    }
    return value as LockRecord;
  } catch {
    return undefined;
  }
};

type HeldLock = Readonly<{
  rootDescriptor: number;
  lockDescriptor: number;
  owner: LockRecord;
}>;
type MetadataLock = Readonly<{
  descriptor: number;
  owner: LockRecord;
}>;

const sameInode = (
  left: Readonly<{ dev: number | bigint; ino: number | bigint }>,
  right: Readonly<{ dev: number | bigint; ino: number | bigint }>,
): boolean => left.dev === right.dev && left.ino === right.ino;

const assertRootIdentity = (
  root: string,
  descriptor: number,
  phase: string,
): void => {
  if (!sameInode(fstatSync(descriptor), lstatSync(root))) {
    throw new Error(`package root changed ${phase}`);
  }
};

const readDescriptor = (descriptor: number): string => {
  const metadata = fstatSync(descriptor);
  if (metadata.size > 64 * 1024) {
    throw new Error('schema generation lock is too large');
  }
  const buffer = Buffer.alloc(metadata.size);
  const bytesRead = readSync(descriptor, buffer, 0, buffer.length, 0);
  return buffer.subarray(0, bytesRead).toString('utf8');
};

const closeLockedDescriptor = (
  descriptor: number,
  system: AtomicDependencies,
): unknown[] => {
  const errors: unknown[] = [];
  try {
    system.unlock(descriptor);
  } catch (error) {
    errors.push(error);
  }
  try {
    closeSync(descriptor);
  } catch (error) {
    errors.push(error);
  }
  return errors;
};

const throwCollected = (errors: readonly unknown[], message: string): void => {
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, message);
};

const acquireMetadataLock = async (
  root: string,
  options: Required<Pick<PublishOptions, 'lockTimeoutMs' | 'staleLockMs'>>,
  system: AtomicDependencies,
  quarantinePaths: string[],
): Promise<MetadataLock> => {
  const lockPath = resolve(root, LOCK_NAME);
  const contender = {
    pid: system.pid,
    hostname: system.hostname(),
    nonce: system.nonce(),
  };
  for (;;) {
    let createdDescriptor: number | undefined;
    try {
      createdDescriptor = openSync(lockPath, 'wx+', 0o600);
      const owner: LockRecord = { ...contender, createdAt: system.now() };
      writeFileSync(createdDescriptor, stableJson(owner));
      return { descriptor: createdDescriptor, owner };
    } catch (error) {
      if (!errno(error, 'EEXIST')) {
        const creationErrors: unknown[] = [error];
        if (createdDescriptor !== undefined) {
          try {
            const pathMetadata = lstatSync(lockPath);
            const fdMetadata = fstatSync(createdDescriptor);
            if (sameInode(pathMetadata, fdMetadata)) unlinkSync(lockPath);
          } catch (cleanupError) {
            if (!errno(cleanupError, 'ENOENT'))
              creationErrors.push(cleanupError);
          }
          try {
            closeSync(createdDescriptor);
          } catch (closeError) {
            creationErrors.push(closeError);
          }
        }
        throwCollected(creationErrors, 'failed to create generation lock');
      }
    }

    let beforeOpen: ReturnType<typeof lstatSync>;
    try {
      beforeOpen = lstatSync(lockPath);
    } catch (error) {
      if (errno(error, 'ENOENT')) continue;
      throw error;
    }
    if (beforeOpen.isSymbolicLink()) {
      throw new Error('schema generation lock is a symbolic link');
    }
    if (!beforeOpen.isFile() || beforeOpen.nlink !== 1) {
      throw new Error('schema generation lock is not a private regular file');
    }
    let existingDescriptor: number;
    try {
      existingDescriptor = openSync(lockPath, 'r+');
    } catch (error) {
      if (errno(error, 'ENOENT')) continue;
      throw error;
    }
    let descriptorMetadata: ReturnType<typeof fstatSync>;
    try {
      descriptorMetadata = fstatSync(existingDescriptor);
    } catch (error) {
      closeSync(existingDescriptor);
      throw error;
    }
    let afterOpen: ReturnType<typeof lstatSync>;
    try {
      afterOpen = lstatSync(lockPath);
    } catch (error) {
      closeSync(existingDescriptor);
      if (errno(error, 'ENOENT')) continue;
      throw error;
    }
    if (
      !sameInode(beforeOpen, descriptorMetadata) ||
      !sameInode(afterOpen, descriptorMetadata)
    ) {
      closeSync(existingDescriptor);
      throw new Error('schema generation lock changed while opening');
    }
    const errors: unknown[] = [];
    try {
      const owner = parseLock(readDescriptor(existingDescriptor));
      if (owner === undefined) {
        throw new Error(
          'schema generation lock is malformed; refusing recovery',
        );
      }
      if (system.now() - owner.createdAt <= options.staleLockMs) {
        throw new Error('schema generation lock is too new; refusing recovery');
      }
      if (owner.hostname !== contender.hostname) {
        throw new Error(
          'schema generation lock belongs to another host; refusing recovery',
        );
      }
      const alive = system.pidIsAlive(owner.pid);
      if (alive !== false) {
        throw new Error(
          alive
            ? 'schema generation lock owner is active'
            : 'schema generation lock owner status is unknown',
        );
      }
      await system.afterStaleInspect();
      const currentPathMetadata = lstatSync(lockPath);
      if (!sameInode(currentPathMetadata, descriptorMetadata)) {
        throw new Error('schema generation lock changed before recovery');
      }
      const quarantinePath = resolve(
        root,
        `${LOCK_NAME}.quarantine-${contender.nonce}`,
      );
      assertSafeFile(quarantinePath, 'schema generation quarantine');
      system.rename(lockPath, quarantinePath);
      quarantinePaths.push(quarantinePath);
    } catch (error) {
      errors.push(error);
    }
    try {
      closeSync(existingDescriptor);
    } catch (error) {
      errors.push(error);
    }
    throwCollected(errors, 'schema generation lock recovery failed');
    await system.sleep(Math.min(25, options.lockTimeoutMs));
  }
};

const acquireLock = async (
  root: string,
  options: Required<Pick<PublishOptions, 'lockTimeoutMs' | 'staleLockMs'>>,
  system: AtomicDependencies,
  quarantinePaths: string[],
): Promise<HeldLock> => {
  const rootDescriptor = openSync(root, 'r');
  try {
    assertRootIdentity(root, rootDescriptor, 'while acquiring generation lock');
  } catch (error) {
    try {
      closeSync(rootDescriptor);
    } catch (closeError) {
      throw new AggregateError(
        [error, closeError],
        'failed to inspect package root and close its descriptor',
      );
    }
    throw error;
  }
  const startedAt = system.monotonicNow();
  try {
    for (;;) {
      if (system.tryLock(rootDescriptor)) break;
      system.onLockCollision();
      if (system.monotonicNow() - startedAt >= options.lockTimeoutMs) {
        throw new Error('schema generation lock owner is active');
      }
      await system.sleep(Math.min(25, options.lockTimeoutMs));
    }
  } catch (error) {
    try {
      closeSync(rootDescriptor);
    } catch (closeError) {
      throw new AggregateError(
        [error, closeError],
        'failed to acquire root advisory lock and close its descriptor',
      );
    }
    throw error;
  }

  try {
    assertRootIdentity(
      root,
      rootDescriptor,
      'while waiting for generation lock',
    );
  } catch (error) {
    const errors = [error, ...closeLockedDescriptor(rootDescriptor, system)];
    throwCollected(
      errors,
      'package root changed after advisory lock acquisition',
    );
    throw new Error('unreachable package root validation');
  }

  try {
    const metadata = await acquireMetadataLock(
      root,
      options,
      system,
      quarantinePaths,
    );
    return {
      rootDescriptor,
      lockDescriptor: metadata.descriptor,
      owner: metadata.owner,
    };
  } catch (error) {
    const errors = [error, ...closeLockedDescriptor(rootDescriptor, system)];
    throwCollected(errors, 'failed to acquire generation metadata lock');
    throw new Error('unreachable generation metadata lock acquisition');
  }
};

const releaseOwnedLock = async (
  root: string,
  held: HeldLock,
  system: AtomicDependencies,
): Promise<unknown[]> => {
  const lockPath = resolve(root, LOCK_NAME);
  const errors: unknown[] = [];
  try {
    assertRootIdentity(
      root,
      held.rootDescriptor,
      'before releasing generation lock',
    );
    const descriptorMetadata = fstatSync(held.lockDescriptor);
    const pathMetadata = lstatSync(lockPath);
    const current = parseLock(readDescriptor(held.lockDescriptor));
    if (!sameInode(pathMetadata, descriptorMetadata)) {
      throw new Error('schema generation lock inode changed before release');
    }
    if (current?.nonce !== held.owner.nonce) {
      throw new Error(
        'schema generation lock ownership changed before release',
      );
    }
    unlinkSync(lockPath);
  } catch (error) {
    if (!errno(error, 'ENOENT')) errors.push(error);
  }
  try {
    closeSync(held.lockDescriptor);
  } catch (error) {
    errors.push(error);
  }
  errors.push(...closeLockedDescriptor(held.rootDescriptor, system));
  return errors;
};

export const publishGeneratedOutputs = async (
  packageRoot: string,
  outputs: Readonly<Record<string, string>>,
  options: PublishOptions = {},
): Promise<void> => {
  const root = resolve(packageRoot);
  assertRoot(root);
  const system = dependencies(options.dependencies);
  for (const [name, value] of [
    ['lockTimeoutMs', options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS],
    ['staleLockMs', options.staleLockMs ?? DEFAULT_STALE_LOCK_MS],
  ] as const) {
    if (!Number.isFinite(value) || value < 0) {
      throw new TypeError(`${name} must be a non-negative finite number`);
    }
  }
  const nonce = system.nonce();
  const stagingRoot = resolve(
    root,
    `.schema-generation.staging-${system.pid}-${nonce}`,
  );
  assertContained(root, stagingRoot);
  mkdirSync(stagingRoot, { mode: 0o700 });
  const stagingMetadata = lstatSync(stagingRoot);
  if (!stagingMetadata.isDirectory() || stagingMetadata.isSymbolicLink()) {
    throw new Error('schema generation staging path is unsafe');
  }

  let prepared: Array<{
    path: string;
    segments: readonly string[];
    stagedPath: string;
    targetPath: string;
  }> = [];
  try {
    const entries = Object.entries(outputs).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    );
    prepared = entries.map(([path, contents]) => {
      const segments = safeRelativePath(path);
      if (typeof contents !== 'string')
        throw new TypeError('generated output must be text');
      const stagedPath = resolve(stagingRoot, ...segments);
      assertContained(stagingRoot, stagedPath);
      ensureSafeDirectory(stagingRoot, segments.slice(0, -1));
      const descriptor = openSync(stagedPath, 'wx', 0o600);
      try {
        writeFileSync(descriptor, contents);
      } finally {
        closeSync(descriptor);
      }
      return {
        path,
        segments,
        stagedPath,
        targetPath: resolve(root, ...segments),
      };
    });
  } catch (error) {
    const preparationErrors: unknown[] = [error];
    try {
      rmSync(stagingRoot, { recursive: true, force: true });
    } catch (cleanupError) {
      preparationErrors.push(cleanupError);
    }
    throwCollected(
      preparationErrors,
      'generation preparation failed and staging cleanup also failed',
    );
  }

  const quarantinePaths: string[] = [];
  let heldLock: HeldLock | undefined;
  const errors: unknown[] = [];
  const promoted: Array<{
    targetPath: string;
    stagedPath: string;
    backupPath?: string;
    installed: boolean;
  }> = [];
  try {
    heldLock = await acquireLock(
      root,
      {
        lockTimeoutMs: options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS,
        staleLockMs: options.staleLockMs ?? DEFAULT_STALE_LOCK_MS,
      },
      system,
      quarantinePaths,
    );
    await system.afterLockAcquired();
    assertRootIdentity(
      root,
      heldLock.rootDescriptor,
      'before promoting generated outputs',
    );

    for (const [index, item] of prepared.entries()) {
      ensureSafeDirectory(root, item.segments.slice(0, -1));
      assertSafeFile(item.targetPath, `generated target ${item.path}`);
      const backupPath = existsSync(item.targetPath)
        ? resolve(stagingRoot, 'backup', String(index))
        : undefined;
      if (backupPath !== undefined) {
        ensureSafeDirectory(stagingRoot, ['backup']);
        system.rename(item.targetPath, backupPath);
      }
      const state = {
        targetPath: item.targetPath,
        stagedPath: item.stagedPath,
        backupPath,
        installed: false,
      };
      promoted.push(state);
      system.rename(item.stagedPath, item.targetPath);
      state.installed = true;
    }
  } catch (promotionError) {
    errors.push(promotionError);
    for (const [index, item] of promoted.reverse().entries()) {
      try {
        if (item.installed && existsSync(item.targetPath)) {
          const discarded = resolve(stagingRoot, `rollback-${index}`);
          system.rename(item.targetPath, discarded);
        }
        if (item.backupPath !== undefined && existsSync(item.backupPath)) {
          system.rename(item.backupPath, item.targetPath);
        }
      } catch (error) {
        errors.push(error);
      }
    }
  }
  if (heldLock !== undefined) {
    try {
      errors.push(...(await releaseOwnedLock(root, heldLock, system)));
    } catch (error) {
      errors.push(error);
    }
  }
  try {
    rmSync(stagingRoot, { recursive: true, force: true });
  } catch (error) {
    errors.push(error);
  }
  for (const path of quarantinePaths) {
    try {
      rmSync(path, { force: true });
    } catch (error) {
      errors.push(error);
    }
  }
  throwCollected(
    errors,
    'schema generation failed and one or more recovery steps also failed',
  );
};

const createOutputs = (): Readonly<Record<string, string>> => {
  const ir = createJsonSchemaIr(contractRegistry.schemas);
  const outputs = {
    'generated/openapi.v2.json': stableJson(
      createOpenApiDocument(contractRegistry),
    ),
    'generated/events.schema.json': stableJson(
      createEventsSchema(contractRegistry),
    ),
    'generated/typescript/contracts.ts': createTypeScriptContracts(
      contractRegistry.schemas,
    ),
    'swift-fixture/Sources/ColorfulCodeContracts/ColorfulCodeContracts.swift':
      createSwiftContracts(ir),
  } satisfies Record<(typeof GENERATED_PATHS)[number], string>;

  JSON.parse(outputs['generated/openapi.v2.json']);
  JSON.parse(outputs['generated/events.schema.json']);
  if (
    !outputs['generated/typescript/contracts.ts'].startsWith(
      '// This file is generated.',
    )
  ) {
    throw new Error('generated TypeScript artifact failed validation');
  }
  if (
    !outputs[
      'swift-fixture/Sources/ColorfulCodeContracts/ColorfulCodeContracts.swift'
    ].startsWith('// This file is generated.')
  ) {
    throw new Error('generated Swift artifact failed validation');
  }
  return outputs;
};

export const generateContracts = async (
  options: PublishOptions & Readonly<{ packageRoot?: string }> = {},
): Promise<void> => {
  const packageRoot = options.packageRoot ?? resolve(import.meta.dir, '..');
  await publishGeneratedOutputs(packageRoot, createOutputs(), options);
};

if (import.meta.main) await generateContracts();
