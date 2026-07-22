import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from 'node:fs';
import { hostname as systemHostname } from 'node:os';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { dlopen, FFIType, read } from 'bun:ffi';

import { createContractOutputs } from './create-contract-outputs.js';
import { stableJson } from './lib/stable-json.js';

export { GENERATED_PATHS } from './create-contract-outputs.js';

const LOCK_NAME = '.schema-generation.lock';
const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const DEFAULT_STALE_LOCK_MS = 30_000;
const LOCK_EXCLUSIVE_NONBLOCKING = 2 | 4;
const LOCK_UNLOCK = 8;
const OPEN_DIRECTORY = process.platform === 'darwin' ? 0x100000 : 0x10000;
const OPEN_NOFOLLOW = process.platform === 'darwin' ? 0x100 : 0x20000;
const OPEN_CREATE = process.platform === 'darwin' ? 0x200 : 0x40;
const OPEN_EXCLUSIVE = process.platform === 'darwin' ? 0x800 : 0x80;
const OPEN_READ_WRITE = 2;
const OPEN_CLOEXEC = process.platform === 'darwin' ? 0x1000000 : 0x80000;
const RENAME_NO_REPLACE = process.platform === 'darwin' ? 0x4 : 0x1;
const TRANSACTION_NAME = '.schema-generation.transaction';
const STAGING_OWNER_NAME = '.owner.json';

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
  openat: {
    args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.i32],
    returns: FFIType.i32,
  },
  renameat: {
    args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.ptr],
    returns: FFIType.i32,
  },
  [process.platform === 'darwin' ? 'renameatx_np' : 'renameat2']: {
    args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.i32],
    returns: FFIType.i32,
  },
  unlinkat: {
    args: [FFIType.i32, FFIType.ptr, FFIType.i32],
    returns: FFIType.i32,
  },
  mkdirat: {
    args: [FFIType.i32, FFIType.ptr, FFIType.i32],
    returns: FFIType.i32,
  },
  fsync: { args: [FFIType.i32], returns: FFIType.i32 },
  fchdir: { args: [FFIType.i32], returns: FFIType.i32 },
  [process.platform === 'darwin' ? '__error' : '__errno_location']: {
    args: [],
    returns: FFIType.ptr,
  },
});
const flock = flockLibrary.symbols.flock;
const openat = flockLibrary.symbols.openat;
const renameat = flockLibrary.symbols.renameat;
const renameatNoReplace =
  flockLibrary.symbols[
    process.platform === 'darwin' ? 'renameatx_np' : 'renameat2'
  ];
const unlinkat = flockLibrary.symbols.unlinkat;
const mkdirat = flockLibrary.symbols.mkdirat;
const fsync = flockLibrary.symbols.fsync;
const fchdir = flockLibrary.symbols.fchdir;
const errnoPointer =
  flockLibrary.symbols[
    process.platform === 'darwin' ? '__error' : '__errno_location'
  ];

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
  afterStaleRevalidate: () => Promise<void>;
  afterReleaseRevalidate: () => Promise<void>;
  afterTargetInspect: () => Promise<void>;
  afterPromotionStep: (step: number) => Promise<void>;
  afterStagingPrepared: () => Promise<void>;
  afterStagingCleanup: () => Promise<void>;
  afterStagingMkdir: () => Promise<void>;
  beforeStagingTreeRemoval: () => void;
  afterPreparedJournalRename: () => void;
  onLockCollision: () => void;
}>;

export type PublishOptions = Readonly<{
  lockTimeoutMs?: number;
  /** Validates caller-owned publication preconditions after recovery while locked. */
  preflightUnderLock?: () => void | Promise<void>;
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
  afterStaleRevalidate: async () => {},
  afterReleaseRevalidate: async () => {},
  afterTargetInspect: async () => {},
  afterPromotionStep: async () => {},
  afterStagingPrepared: async () => {},
  afterStagingCleanup: async () => {},
  afterStagingMkdir: async () => {},
  beforeStagingTreeRemoval: () => {},
  afterPreparedJournalRename: () => {},
  onLockCollision: () => {},
  ...overrides,
});

const nativeName = (name: string): Buffer => Buffer.from(`${name}\0`);
const identityToken = (value: string): string =>
  createHash('sha256').update(value).digest('hex').slice(0, 16);

const openDirectoryAt = (descriptor: number, name: string): number => {
  const opened = openat(
    descriptor,
    nativeName(name),
    OPEN_DIRECTORY | OPEN_NOFOLLOW | OPEN_CLOEXEC,
    0,
  );
  if (opened < 0) throw new Error(`failed to open real directory ${name}`);
  const metadata = fstatSync(opened);
  if (!metadata.isDirectory()) {
    closeSync(opened);
    throw new TypeError('generated output parent is not a real directory');
  }
  return opened;
};

const syncDescriptor = (descriptor: number, label: string): void => {
  if (fsync(descriptor) !== 0) throw new Error(`failed to fsync ${label}`);
};

const renameAt = (
  fromDescriptor: number,
  fromName: string,
  toDescriptor: number,
  toName: string,
): void => {
  if (
    renameat(
      fromDescriptor,
      nativeName(fromName),
      toDescriptor,
      nativeName(toName),
    ) !== 0
  ) {
    throw new Error(`failed to atomically rename ${fromName} to ${toName}`);
  }
};

const renameAtNoReplace = (
  fromDescriptor: number,
  fromName: string,
  toDescriptor: number,
  toName: string,
): void => {
  if (
    renameatNoReplace(
      fromDescriptor,
      nativeName(fromName),
      toDescriptor,
      nativeName(toName),
      RENAME_NO_REPLACE,
    ) !== 0
  ) {
    throw new Error(`failed to atomically install ${fromName} as ${toName}`);
  }
};

const unlinkAt = (descriptor: number, name: string): void => {
  if (unlinkat(descriptor, nativeName(name), 0) !== 0) {
    throw new Error(`failed to unlink ${name}`);
  }
};

const assertPathMatchesDescriptor = (
  parentDescriptor: number,
  name: string,
  expectedDescriptor: number,
  label: string,
): void => {
  const current = openat(
    parentDescriptor,
    nativeName(name),
    OPEN_NOFOLLOW | OPEN_CLOEXEC,
    0,
  );
  if (current < 0) throw new Error(`${label} changed before rename`);
  try {
    const currentMetadata = fstatSync(current);
    const expectedMetadata = fstatSync(expectedDescriptor);
    if (
      !currentMetadata.isFile() ||
      currentMetadata.nlink !== 1 ||
      !sameInode(currentMetadata, expectedMetadata)
    ) {
      throw new Error(`${label} inode changed before rename`);
    }
  } finally {
    closeSync(current);
  }
};

const verifyQuarantinedLock = (
  quarantineDescriptor: number,
  quarantineName: string,
  rootDescriptor: number,
  expectedDescriptor: number,
  preservedName: string,
): void => {
  try {
    assertPathMatchesDescriptor(
      quarantineDescriptor,
      quarantineName,
      expectedDescriptor,
      'schema generation lock quarantine',
    );
  } catch (verificationError) {
    const errors: unknown[] = [verificationError];
    try {
      renameAtNoReplace(
        quarantineDescriptor,
        quarantineName,
        rootDescriptor,
        LOCK_NAME,
      );
      syncDescriptor(quarantineDescriptor, 'lock quarantine restore source');
      if (quarantineDescriptor !== rootDescriptor) {
        syncDescriptor(rootDescriptor, 'lock quarantine restore destination');
      }
    } catch (restoreError) {
      errors.push(restoreError);
      if (quarantineDescriptor !== rootDescriptor) {
        try {
          renameAtNoReplace(
            quarantineDescriptor,
            quarantineName,
            rootDescriptor,
            preservedName,
          );
          syncDescriptor(
            quarantineDescriptor,
            'lock quarantine preservation source',
          );
          syncDescriptor(rootDescriptor, 'lock quarantine preservation root');
        } catch (preservationError) {
          errors.push(preservationError);
        }
      }
    }
    throwCollected(errors, 'schema generation lock quarantine changed');
  }
};

const mkdirAt = (descriptor: number, name: string, mode: number): void => {
  if (mkdirat(descriptor, nativeName(name), mode) !== 0) {
    throw new Error(`failed to create directory ${name}`);
  }
};

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

const assertPublicOutputPath = (segments: readonly string[]): void => {
  if (segments[0]!.startsWith('.schema-generation.')) {
    throw new TypeError('generated output uses a reserved namespace');
  }
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

type BoundFile = Readonly<{
  parentDescriptor: number;
  name: string;
  path: string;
}>;

const openBoundPrivateFile = (file: BoundFile, label: string): number => {
  const descriptor = openat(
    file.parentDescriptor,
    nativeName(file.name),
    OPEN_NOFOLLOW | OPEN_CLOEXEC,
    0,
  );
  if (descriptor < 0) throw new Error(`${label} changed before open`);
  try {
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile() || metadata.nlink !== 1) {
      throw new Error(`${label} is not a private regular file`);
    }
    return descriptor;
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
};

const bindFile = (
  rootDescriptor: number,
  root: string,
  segments: readonly string[],
): BoundFile => {
  if (segments.length === 0) throw new TypeError('file path is empty');
  let parentDescriptor = rootDescriptor;
  try {
    for (const segment of segments.slice(0, -1)) {
      const child = openDirectoryAt(parentDescriptor, segment);
      if (parentDescriptor !== rootDescriptor) closeSync(parentDescriptor);
      parentDescriptor = child;
    }
    return {
      parentDescriptor,
      name: segments.at(-1)!,
      path: resolve(root, ...segments),
    };
  } catch (error) {
    if (parentDescriptor !== rootDescriptor) closeSync(parentDescriptor);
    throw error;
  }
};

const closeBoundFile = (file: BoundFile, rootDescriptor: number): void => {
  if (file.parentDescriptor !== rootDescriptor)
    closeSync(file.parentDescriptor);
};

const syncDirectoryChain = (
  rootDescriptor: number,
  segments: readonly string[],
): void => {
  let current = rootDescriptor;
  try {
    syncDescriptor(current, 'directory chain root');
    for (const segment of segments) {
      const child = openDirectoryAt(current, segment);
      try {
        syncDescriptor(current, 'directory chain parent');
      } catch (error) {
        closeSync(child);
        throw error;
      }
      if (current !== rootDescriptor) closeSync(current);
      current = child;
      syncDescriptor(current, 'directory chain child');
    }
  } finally {
    if (current !== rootDescriptor) closeSync(current);
  }
};

const renameBound = (
  from: BoundFile,
  to: BoundFile,
  renameOverride: AtomicDependencies['rename'] | undefined,
): void => {
  renameAt(from.parentDescriptor, from.name, to.parentDescriptor, to.name);
  renameOverride?.(from.path, to.path);
  syncDescriptor(from.parentDescriptor, 'rename source directory');
  if (to.parentDescriptor !== from.parentDescriptor) {
    syncDescriptor(to.parentDescriptor, 'rename destination directory');
  }
};

const installAbsentBound = (
  from: BoundFile,
  to: BoundFile,
  renameOverride: AtomicDependencies['rename'] | undefined,
): void => {
  renameAtNoReplace(
    from.parentDescriptor,
    from.name,
    to.parentDescriptor,
    to.name,
  );
  renameOverride?.(from.path, to.path);
  syncDescriptor(from.parentDescriptor, 'rename source directory');
  if (to.parentDescriptor !== from.parentDescriptor) {
    syncDescriptor(to.parentDescriptor, 'rename destination directory');
  }
};

const backupVerifiedBound = (
  target: BoundFile,
  backup: BoundFile,
  rootDescriptor: number,
  expectedDescriptor: number,
  preservedName: string,
  renameOverride: AtomicDependencies['rename'] | undefined,
): void => {
  renameAt(
    target.parentDescriptor,
    target.name,
    backup.parentDescriptor,
    backup.name,
  );
  try {
    assertPathMatchesDescriptor(
      backup.parentDescriptor,
      backup.name,
      expectedDescriptor,
      'generated target backup',
    );
  } catch (verificationError) {
    const errors: unknown[] = [verificationError];
    try {
      renameAtNoReplace(
        backup.parentDescriptor,
        backup.name,
        target.parentDescriptor,
        target.name,
      );
      syncDescriptor(backup.parentDescriptor, 'target backup restore source');
      if (backup.parentDescriptor !== target.parentDescriptor) {
        syncDescriptor(target.parentDescriptor, 'target backup restore target');
      }
    } catch (restoreError) {
      errors.push(restoreError);
      try {
        renameAtNoReplace(
          backup.parentDescriptor,
          backup.name,
          rootDescriptor,
          preservedName,
        );
        syncDescriptor(
          backup.parentDescriptor,
          'target backup preservation source',
        );
        syncDescriptor(rootDescriptor, 'target backup preservation root');
      } catch (preservationError) {
        errors.push(preservationError);
      }
    }
    throwCollected(errors, 'generated target changed during backup');
  }
  renameOverride?.(target.path, backup.path);
  syncDescriptor(target.parentDescriptor, 'rename source directory');
  if (backup.parentDescriptor !== target.parentDescriptor) {
    syncDescriptor(backup.parentDescriptor, 'rename destination directory');
  }
};

type TransactionEntry = Readonly<{
  target: string;
  staged: string;
  backup: string;
  hadOriginal: boolean;
}>;
type TransactionRecord = Readonly<{
  version: 1;
  state: 'prepared' | 'committed';
  staging: string;
  entries: readonly TransactionEntry[];
}>;

const parseTransaction = (source: string): TransactionRecord => {
  const value = JSON.parse(source) as Partial<TransactionRecord>;
  if (
    value.version !== 1 ||
    (value.state !== 'prepared' && value.state !== 'committed') ||
    typeof value.staging !== 'string' ||
    !value.staging.startsWith('.schema-generation.staging-') ||
    !Array.isArray(value.entries)
  ) {
    throw new Error('schema generation transaction journal is malformed');
  }
  const stagingSegments = safeRelativePath(value.staging);
  if (stagingSegments.length !== 1) {
    throw new Error('schema generation transaction staging path is unsafe');
  }
  const targets = new Set<string>();
  for (const [index, entry] of value.entries.entries()) {
    if (
      entry === null ||
      typeof entry !== 'object' ||
      typeof entry.target !== 'string' ||
      typeof entry.staged !== 'string' ||
      typeof entry.backup !== 'string' ||
      typeof entry.hadOriginal !== 'boolean'
    ) {
      throw new Error('schema generation transaction entry is malformed');
    }
    safeRelativePath(entry.target);
    safeRelativePath(entry.staged);
    safeRelativePath(entry.backup);
    assertPublicOutputPath(safeRelativePath(entry.target));
    if (
      targets.has(entry.target) ||
      entry.staged !== `${value.staging}/${entry.target}` ||
      entry.backup !== `${value.staging}/backup/${index}`
    ) {
      throw new Error('schema generation transaction paths are inconsistent');
    }
    targets.add(entry.target);
  }
  return value as TransactionRecord;
};

const descriptorExists = (file: BoundFile): boolean => {
  const descriptor = openat(
    file.parentDescriptor,
    nativeName(file.name),
    OPEN_NOFOLLOW | OPEN_CLOEXEC,
    0,
  );
  if (descriptor < 0) {
    const nativeErrno = read.i32(errnoPointer());
    if (nativeErrno === 2) return false;
    throw new Error(`failed to inspect ${file.name} (errno ${nativeErrno})`);
  }
  try {
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile() || metadata.nlink !== 1) {
      throw new Error(`${file.name} is not a private regular file`);
    }
    return true;
  } finally {
    closeSync(descriptor);
  }
};

const writeTransaction = (
  rootDescriptor: number,
  record: TransactionRecord,
  nonce: string,
  afterRename: () => void,
): void => {
  const temporaryName = `.transaction-${identityToken(nonce)}.tmp`;
  const stagingDescriptor = openDirectoryAt(rootDescriptor, record.staging);
  try {
    const descriptor = openat(
      stagingDescriptor,
      nativeName(temporaryName),
      OPEN_READ_WRITE |
        OPEN_CREATE |
        OPEN_EXCLUSIVE |
        OPEN_NOFOLLOW |
        OPEN_CLOEXEC,
      0o600,
    );
    if (descriptor < 0) {
      throw new Error('failed to create schema generation transaction journal');
    }
    try {
      fchmodSync(descriptor, 0o600);
      writeFileSync(descriptor, stableJson(record));
      syncDescriptor(descriptor, 'transaction journal');
    } finally {
      closeSync(descriptor);
    }
    syncDescriptor(stagingDescriptor, 'transaction staging directory');
    renameAt(
      stagingDescriptor,
      temporaryName,
      rootDescriptor,
      TRANSACTION_NAME,
    );
    afterRename();
    syncDescriptor(rootDescriptor, 'package root transaction journal');
  } finally {
    closeSync(stagingDescriptor);
  }
};

const readTransaction = (
  root: string,
  rootDescriptor: number,
): TransactionRecord | undefined => {
  const journalPath = resolve(root, TRANSACTION_NAME);
  const descriptor = openat(
    rootDescriptor,
    nativeName(TRANSACTION_NAME),
    OPEN_NOFOLLOW | OPEN_CLOEXEC,
    0,
  );
  if (descriptor < 0) {
    try {
      lstatSync(journalPath);
    } catch (error) {
      if (errno(error, 'ENOENT')) return undefined;
      throw error;
    }
    throw new Error('failed to open schema generation transaction journal');
  }
  try {
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile() || metadata.nlink !== 1) {
      throw new Error('schema generation transaction journal is unsafe');
    }
    return parseTransaction(readDescriptor(descriptor));
  } finally {
    closeSync(descriptor);
  }
};

const recoverTransaction = (
  root: string,
  rootDescriptor: number,
  renameOverride: AtomicDependencies['rename'] | undefined,
): void => {
  const record = readTransaction(root, rootDescriptor);
  if (record === undefined) return;
  const stagingPath = resolve(root, record.staging);
  let stagingExists = true;
  let stagingIdentity:
    | Readonly<{ dev: number | bigint; ino: number | bigint }>
    | undefined;
  try {
    const stagingMetadata = lstatSync(stagingPath);
    if (!stagingMetadata.isDirectory() || stagingMetadata.isSymbolicLink()) {
      throw new Error('schema generation recovery staging directory is unsafe');
    }
    stagingIdentity = {
      dev: stagingMetadata.dev,
      ino: stagingMetadata.ino,
    };
  } catch (error) {
    if (!errno(error, 'ENOENT')) throw error;
    stagingExists = false;
  }
  if (record.state === 'committed') {
    assertRootIdentity(root, rootDescriptor, 'before committed cleanup');
    if (stagingExists)
      removePinnedDirectoryTree(
        root,
        rootDescriptor,
        record.staging,
        stagingIdentity,
      );
    unlinkAt(rootDescriptor, TRANSACTION_NAME);
    syncDescriptor(rootDescriptor, 'package root after committed recovery');
    return;
  }
  if (!stagingExists) {
    throw new Error('schema generation recovery staging directory is missing');
  }
  for (const [index, entry] of record.entries.entries()) {
    const targetSegments = safeRelativePath(entry.target);
    const stagedSegments = safeRelativePath(entry.staged);
    const backupSegments = safeRelativePath(entry.backup);
    const files: BoundFile[] = [];
    try {
      const target = bindFile(rootDescriptor, root, targetSegments);
      files.push(target);
      const staged = bindFile(rootDescriptor, root, stagedSegments);
      files.push(staged);
      const backup = bindFile(rootDescriptor, root, backupSegments);
      files.push(backup);
      const discard = bindFile(rootDescriptor, root, [
        record.staging,
        `recovery-discard-${index}`,
      ]);
      files.push(discard);
      const targetExists = descriptorExists(target);
      const stagedExists = descriptorExists(staged);
      const backupExists = descriptorExists(backup);
      const discardExists = descriptorExists(discard);
      if (entry.hadOriginal) {
        if (backupExists) {
          if (targetExists) renameBound(target, discard, renameOverride);
          renameBound(backup, target, renameOverride);
        } else if (!targetExists || (!stagedExists && !discardExists)) {
          throw new Error('cannot safely recover interrupted generation');
        }
      } else if (!stagedExists) {
        if (!targetExists && !discardExists) {
          throw new Error('cannot safely recover missing generated target');
        }
        if (targetExists) renameBound(target, discard, renameOverride);
      } else if (targetExists) {
        throw new Error('cannot safely recover ambiguous generated target');
      }
    } finally {
      for (const file of files) {
        closeBoundFile(file, rootDescriptor);
      }
    }
  }
  unlinkAt(rootDescriptor, TRANSACTION_NAME);
  syncDescriptor(rootDescriptor, 'package root after recovery');
  assertRootIdentity(root, rootDescriptor, 'before recovery cleanup');
  removePinnedDirectoryTree(
    root,
    rootDescriptor,
    record.staging,
    stagingIdentity,
  );
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
  orphanStaging: readonly OrphanStaging[];
}>;
type MetadataLock = Readonly<{
  descriptor: number;
  owner: LockRecord;
}>;

const sameInode = (
  left: Readonly<{ dev: number | bigint; ino: number | bigint }>,
  right: Readonly<{ dev: number | bigint; ino: number | bigint }>,
): boolean => left.dev === right.dev && left.ino === right.ino;

type OrphanStaging = Readonly<{
  name: string;
  identity: Readonly<{ dev: number | bigint; ino: number | bigint }>;
}>;

const assertRootIdentity = (
  root: string,
  descriptor: number,
  phase: string,
): void => {
  if (!sameInode(fstatSync(descriptor), lstatSync(root))) {
    throw new Error(`package root changed ${phase}`);
  }
};

const removePinnedDirectoryTree = (
  root: string,
  rootDescriptor: number,
  name: string,
  expectedIdentity?: Readonly<{ dev: number | bigint; ino: number | bigint }>,
  beforeRemoval: () => void = () => {},
): void => {
  const path = resolve(root, name);
  try {
    lstatSync(path);
  } catch (error) {
    if (errno(error, 'ENOENT')) return;
    throw error;
  }
  assertRootIdentity(root, rootDescriptor, 'before pinned tree cleanup');
  const directory = openDirectoryAt(rootDescriptor, name);
  const identity = fstatSync(directory);
  if (
    expectedIdentity !== undefined &&
    !sameInode(identity, expectedIdentity)
  ) {
    closeSync(directory);
    throw new Error('staging identity changed before pinned cleanup');
  }
  const original = openSync('.', OPEN_DIRECTORY | OPEN_CLOEXEC);
  let entered = false;
  let restored = false;
  try {
    if (fchdir(directory) !== 0) {
      throw new Error('failed to enter staging directory for cleanup');
    }
    entered = true;
    if (!sameInode(identity, lstatSync('.'))) {
      throw new Error('staging identity changed during pinned cleanup');
    }
    beforeRemoval();
    for (const child of readdirSync('.')) {
      rmSync(child, { force: true, recursive: true });
    }
  } finally {
    if (entered) restored = fchdir(original) === 0;
    closeSync(original);
    closeSync(directory);
  }
  if (!restored) throw new Error('failed to restore cwd after staging cleanup');
  assertRootIdentity(root, rootDescriptor, 'after pinned tree cleanup');
  const current = lstatSync(path);
  if (!sameInode(identity, current)) {
    throw new Error('staging identity changed before final removal');
  }
  rmdirSync(path);
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

const inspectOrphanStaging = (
  root: string,
  rootDescriptor: number,
  protectedStaging: string | undefined,
  system: AtomicDependencies,
): readonly OrphanStaging[] => {
  assertRootIdentity(root, rootDescriptor, 'before staging inspection');
  const result: OrphanStaging[] = [];
  for (const name of readdirSync(root)) {
    if (
      !name.startsWith('.schema-generation.staging-') ||
      name === protectedStaging
    ) {
      continue;
    }
    const identity =
      /^\.schema-generation\.staging-(\d+)-([a-f0-9]{16})-[a-f0-9]{16}$/.exec(
        name,
      );
    if (identity === null) {
      throw new Error('orphan staging name has no safe owner identity');
    }
    const encodedPid = Number(identity[1]);
    const encodedLocalHost = identity[2] === identityToken(system.hostname());
    const stagingDescriptor = openDirectoryAt(rootDescriptor, name);
    try {
      const stagingMetadata = fstatSync(stagingDescriptor);
      const ownerDescriptor = openat(
        stagingDescriptor,
        nativeName(STAGING_OWNER_NAME),
        OPEN_NOFOLLOW | OPEN_CLOEXEC,
        0,
      );
      let owner: LockRecord | undefined;
      if (ownerDescriptor >= 0) {
        try {
          const metadata = fstatSync(ownerDescriptor);
          if (metadata.isFile() && metadata.nlink === 1) {
            owner = parseLock(readDescriptor(ownerDescriptor));
          }
        } finally {
          closeSync(ownerDescriptor);
        }
      }
      const ownerPid = owner?.pid ?? encodedPid;
      const ownerIsLocal =
        owner === undefined
          ? encodedLocalHost
          : owner.hostname === system.hostname() &&
            owner.pid === encodedPid &&
            encodedLocalHost;
      if (!ownerIsLocal) {
        throw new Error('orphan staging owner is unknown or foreign');
      }
      if (system.pidIsAlive(ownerPid) !== false) {
        throw new Error('orphan staging owner is active or unknown');
      }
      result.push({
        name,
        identity: {
          dev: stagingMetadata.dev,
          ino: stagingMetadata.ino,
        },
      });
    } finally {
      closeSync(stagingDescriptor);
    }
  }
  return result;
};

const isolateAndRemoveOrphanStaging = (
  root: string,
  rootDescriptor: number,
  orphan: OrphanStaging,
  quarantineName: string,
  renameOverride: AtomicDependencies['rename'] | undefined,
): void => {
  assertRootIdentity(root, rootDescriptor, 'before orphan isolation');
  const orphanDescriptor = openDirectoryAt(rootDescriptor, orphan.name);
  try {
    if (!sameInode(fstatSync(orphanDescriptor), orphan.identity)) {
      throw new Error('orphan staging identity changed before isolation');
    }

    mkdirAt(rootDescriptor, quarantineName, 0o700);
    syncDescriptor(rootDescriptor, 'package root after orphan quarantine');
    const quarantineDescriptor = openDirectoryAt(
      rootDescriptor,
      quarantineName,
    );
    try {
      const quarantineIdentity = fstatSync(quarantineDescriptor);
      renameAt(rootDescriptor, orphan.name, quarantineDescriptor, 'payload');
      renameOverride?.(
        resolve(root, orphan.name),
        resolve(root, quarantineName, 'payload'),
      );
      syncDescriptor(rootDescriptor, 'package root after orphan isolation');
      syncDescriptor(quarantineDescriptor, 'orphan quarantine directory');

      const isolatedDescriptor = openDirectoryAt(
        quarantineDescriptor,
        'payload',
      );
      try {
        if (!sameInode(fstatSync(isolatedDescriptor), orphan.identity)) {
          throw new Error('orphan staging identity changed during isolation');
        }
      } finally {
        closeSync(isolatedDescriptor);
      }

      assertRootIdentity(root, rootDescriptor, 'before orphan deletion');
      const quarantinePath = resolve(root, quarantineName);
      const quarantinePathMetadata = lstatSync(quarantinePath);
      if (!sameInode(quarantinePathMetadata, quarantineIdentity)) {
        throw new Error('orphan quarantine identity changed before deletion');
      }
      const isolatedPathMetadata = lstatSync(
        resolve(quarantinePath, 'payload'),
      );
      if (!sameInode(isolatedPathMetadata, orphan.identity)) {
        throw new Error('isolated orphan identity changed before deletion');
      }
      removePinnedDirectoryTree(
        root,
        rootDescriptor,
        quarantineName,
        quarantineIdentity,
      );
      syncDescriptor(rootDescriptor, 'package root after orphan cleanup');
    } finally {
      closeSync(quarantineDescriptor);
    }
  } finally {
    closeSync(orphanDescriptor);
  }
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
  rootDescriptor: number,
  options: Required<Pick<PublishOptions, 'lockTimeoutMs' | 'staleLockMs'>>,
  system: AtomicDependencies,
  quarantinePaths: string[],
  recoveryStaging: string | undefined,
  crashRecovery: boolean,
): Promise<MetadataLock> => {
  const contender = {
    pid: system.pid,
    hostname: system.hostname(),
    nonce: system.nonce(),
  };
  for (;;) {
    const createdDescriptor = openat(
      rootDescriptor,
      nativeName(LOCK_NAME),
      OPEN_READ_WRITE |
        OPEN_CREATE |
        OPEN_EXCLUSIVE |
        OPEN_NOFOLLOW |
        OPEN_CLOEXEC,
      0o600,
    );
    if (createdDescriptor >= 0) {
      try {
        fchmodSync(createdDescriptor, 0o600);
        const owner: LockRecord = { ...contender, createdAt: system.now() };
        writeFileSync(createdDescriptor, stableJson(owner));
        syncDescriptor(createdDescriptor, 'generation metadata lock');
        return { descriptor: createdDescriptor, owner };
      } catch (error) {
        const creationErrors: unknown[] = [error];
        try {
          unlinkAt(rootDescriptor, LOCK_NAME);
        } catch (cleanupError) {
          creationErrors.push(cleanupError);
        }
        try {
          closeSync(createdDescriptor);
        } catch (closeError) {
          creationErrors.push(closeError);
        }
        throwCollected(creationErrors, 'failed to create generation lock');
      }
    }
    const existingDescriptor = openat(
      rootDescriptor,
      nativeName(LOCK_NAME),
      OPEN_READ_WRITE | OPEN_NOFOLLOW | OPEN_CLOEXEC,
      0,
    );
    if (existingDescriptor < 0) {
      throw new Error('schema generation lock is a symbolic link or unsafe');
    }
    let descriptorMetadata: ReturnType<typeof fstatSync>;
    try {
      descriptorMetadata = fstatSync(existingDescriptor);
    } catch (error) {
      closeSync(existingDescriptor);
      throw error;
    }
    if (!descriptorMetadata.isFile() || descriptorMetadata.nlink !== 1) {
      closeSync(existingDescriptor);
      throw new Error('schema generation lock is not a private regular file');
    }
    const errors: unknown[] = [];
    try {
      const owner = parseLock(readDescriptor(existingDescriptor));
      if (owner === undefined) {
        throw new Error(
          'schema generation lock is malformed; refusing recovery',
        );
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
      if (
        !crashRecovery &&
        system.now() - owner.createdAt <= options.staleLockMs
      ) {
        throw new Error('schema generation lock is too new; refusing recovery');
      }
      await system.afterStaleInspect();
      assertPathMatchesDescriptor(
        rootDescriptor,
        LOCK_NAME,
        existingDescriptor,
        'schema generation lock',
      );
      await system.afterStaleRevalidate();
      const quarantineName = `${LOCK_NAME}.quarantine-${contender.nonce}`;
      const preservedName = `${LOCK_NAME}.preserved-${contender.nonce}`;
      if (recoveryStaging !== undefined) {
        const stagingDescriptor = openDirectoryAt(
          rootDescriptor,
          recoveryStaging,
        );
        try {
          renameAt(
            rootDescriptor,
            LOCK_NAME,
            stagingDescriptor,
            quarantineName,
          );
          verifyQuarantinedLock(
            stagingDescriptor,
            quarantineName,
            rootDescriptor,
            existingDescriptor,
            preservedName,
          );
          syncDescriptor(stagingDescriptor, 'recovery staging directory');
        } finally {
          closeSync(stagingDescriptor);
        }
      } else {
        const quarantinePath = resolve(root, quarantineName);
        assertSafeFile(quarantinePath, 'schema generation quarantine');
        renameAt(rootDescriptor, LOCK_NAME, rootDescriptor, quarantineName);
        verifyQuarantinedLock(
          rootDescriptor,
          quarantineName,
          rootDescriptor,
          existingDescriptor,
          preservedName,
        );
        quarantinePaths.push(quarantinePath);
      }
      syncDescriptor(rootDescriptor, 'package root after stale lock recovery');
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
    const interruptedTransaction = readTransaction(root, rootDescriptor);
    const orphanStaging = inspectOrphanStaging(
      root,
      rootDescriptor,
      interruptedTransaction?.staging,
      system,
    );
    let recoveryStaging: string | undefined;
    if (interruptedTransaction !== undefined) {
      try {
        const descriptor = openDirectoryAt(
          rootDescriptor,
          interruptedTransaction.staging,
        );
        closeSync(descriptor);
        recoveryStaging = interruptedTransaction.staging;
      } catch {
        recoveryStaging = undefined;
      }
    }
    const metadata = await acquireMetadataLock(
      root,
      rootDescriptor,
      options,
      system,
      quarantinePaths,
      recoveryStaging,
      interruptedTransaction !== undefined || orphanStaging.length > 0,
    );
    return {
      rootDescriptor,
      lockDescriptor: metadata.descriptor,
      owner: metadata.owner,
      orphanStaging,
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
  const errors: unknown[] = [];
  try {
    assertRootIdentity(
      root,
      held.rootDescriptor,
      'before releasing generation lock',
    );
    const descriptorMetadata = fstatSync(held.lockDescriptor);
    const current = parseLock(readDescriptor(held.lockDescriptor));
    const currentDescriptor = openat(
      held.rootDescriptor,
      nativeName(LOCK_NAME),
      OPEN_READ_WRITE | OPEN_NOFOLLOW | OPEN_CLOEXEC,
      0,
    );
    if (currentDescriptor < 0) throw new Error('generation lock disappeared');
    let currentPathMetadata: ReturnType<typeof fstatSync>;
    try {
      currentPathMetadata = fstatSync(currentDescriptor);
    } finally {
      closeSync(currentDescriptor);
    }
    if (!sameInode(currentPathMetadata, descriptorMetadata))
      throw new Error('schema generation lock inode changed before release');
    if (current?.nonce !== held.owner.nonce) {
      throw new Error(
        'schema generation lock ownership changed before release',
      );
    }
    await system.afterReleaseRevalidate();
    const token = identityToken(held.owner.nonce);
    const releaseName = `${LOCK_NAME}.release-${token}`;
    const preservedName = `${LOCK_NAME}.preserved-release-${token}`;
    renameAtNoReplace(
      held.rootDescriptor,
      LOCK_NAME,
      held.rootDescriptor,
      releaseName,
    );
    verifyQuarantinedLock(
      held.rootDescriptor,
      releaseName,
      held.rootDescriptor,
      held.lockDescriptor,
      preservedName,
    );
    unlinkAt(held.rootDescriptor, releaseName);
    syncDescriptor(held.rootDescriptor, 'package root after lock release');
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
  const renameOverride = options.dependencies?.rename;
  for (const [name, value] of [
    ['lockTimeoutMs', options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS],
    ['staleLockMs', options.staleLockMs ?? DEFAULT_STALE_LOCK_MS],
  ] as const) {
    if (!Number.isFinite(value) || value < 0) {
      throw new TypeError(`${name} must be a non-negative finite number`);
    }
  }
  const nonce = system.nonce();
  const generationHostname = system.hostname();
  const stagingName = `.schema-generation.staging-${system.pid}-${identityToken(
    generationHostname,
  )}-${identityToken(nonce)}`;
  const stagingRoot = resolve(root, stagingName);
  assertContained(root, stagingRoot);
  const entries = Object.entries(outputs)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([path, contents]) => {
      const segments = safeRelativePath(path);
      assertPublicOutputPath(segments);
      if (typeof contents !== 'string') {
        throw new TypeError('generated output must be text');
      }
      return { path, contents, segments };
    });
  let prepared: Array<{
    path: string;
    segments: readonly string[];
    stagedPath: string;
    targetPath: string;
  }> = [];

  const quarantinePaths: string[] = [];
  let heldLock: HeldLock | undefined;
  const errors: unknown[] = [];
  let preserveStagingForRecovery = false;
  let transactionCommitted = false;
  let currentTransactionStarted = false;
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
    recoverTransaction(root, heldLock.rootDescriptor, renameOverride);
    for (const [index, orphan] of heldLock.orphanStaging.entries()) {
      isolateAndRemoveOrphanStaging(
        root,
        heldLock.rootDescriptor,
        orphan,
        `.schema-generation.orphan-quarantine-${identityToken(nonce)}-${index}`,
        renameOverride,
      );
    }
    await options.preflightUnderLock?.();

    mkdirAt(heldLock.rootDescriptor, stagingName, 0o700);
    syncDescriptor(heldLock.rootDescriptor, 'package root after staging');
    await system.afterStagingMkdir();
    const stagingDescriptor = openDirectoryAt(
      heldLock.rootDescriptor,
      stagingName,
    );
    try {
      const ownerDescriptor = openat(
        stagingDescriptor,
        nativeName(STAGING_OWNER_NAME),
        OPEN_READ_WRITE |
          OPEN_CREATE |
          OPEN_EXCLUSIVE |
          OPEN_NOFOLLOW |
          OPEN_CLOEXEC,
        0o600,
      );
      if (ownerDescriptor < 0) {
        throw new Error('failed to create staging owner manifest');
      }
      try {
        fchmodSync(ownerDescriptor, 0o600);
        writeFileSync(
          ownerDescriptor,
          stableJson({
            pid: system.pid,
            hostname: generationHostname,
            nonce,
            createdAt: system.now(),
          }),
        );
        syncDescriptor(ownerDescriptor, 'staging owner manifest');
      } finally {
        closeSync(ownerDescriptor);
      }
      syncDescriptor(stagingDescriptor, 'staging owner directory');
    } finally {
      closeSync(stagingDescriptor);
    }
    await system.afterStagingPrepared();
    const stagingMetadata = lstatSync(stagingRoot);
    if (!stagingMetadata.isDirectory() || stagingMetadata.isSymbolicLink()) {
      throw new Error('schema generation staging path is unsafe');
    }
    prepared = entries.map(({ path, contents, segments }) => {
      const stagedPath = resolve(stagingRoot, ...segments);
      assertContained(stagingRoot, stagedPath);
      ensureSafeDirectory(stagingRoot, segments.slice(0, -1));
      const descriptor = openSync(stagedPath, 'wx', 0o600);
      try {
        writeFileSync(descriptor, contents);
        syncDescriptor(descriptor, `staged output ${path}`);
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
    for (const item of prepared) {
      syncDirectoryChain(heldLock.rootDescriptor, [
        stagingName,
        ...item.segments.slice(0, -1),
      ]);
    }

    ensureSafeDirectory(stagingRoot, ['backup']);
    syncDirectoryChain(heldLock.rootDescriptor, [stagingName, 'backup']);
    const transaction: TransactionRecord = {
      version: 1,
      state: 'prepared',
      staging: stagingName,
      entries: prepared.map((item, index) => ({
        target: item.path,
        staged: `${stagingName}/${item.path}`,
        backup: `${stagingName}/backup/${index}`,
        hadOriginal: existsSync(item.targetPath),
      })),
    };
    for (const item of prepared) {
      ensureSafeDirectory(root, item.segments.slice(0, -1));
      syncDirectoryChain(heldLock.rootDescriptor, item.segments.slice(0, -1));
      assertSafeFile(item.targetPath, `generated target ${item.path}`);
    }
    for (const entry of transaction.entries) {
      const files: BoundFile[] = [];
      try {
        for (const path of [entry.target, entry.staged, entry.backup]) {
          files.push(
            bindFile(heldLock.rootDescriptor, root, safeRelativePath(path)),
          );
        }
        for (const file of files) {
          syncDescriptor(file.parentDescriptor, 'prepared output directory');
        }
      } finally {
        for (const file of files) {
          closeBoundFile(file, heldLock.rootDescriptor);
        }
      }
    }
    writeTransaction(
      heldLock.rootDescriptor,
      transaction,
      nonce,
      system.afterPreparedJournalRename,
    );
    currentTransactionStarted = true;
    preserveStagingForRecovery = true;

    for (const [index, entry] of transaction.entries.entries()) {
      const files: BoundFile[] = [];
      let expectedTargetDescriptor: number | undefined;
      try {
        const target = bindFile(
          heldLock.rootDescriptor,
          root,
          safeRelativePath(entry.target),
        );
        files.push(target);
        const staged = bindFile(
          heldLock.rootDescriptor,
          root,
          safeRelativePath(entry.staged),
        );
        files.push(staged);
        const backup = bindFile(
          heldLock.rootDescriptor,
          root,
          safeRelativePath(entry.backup),
        );
        files.push(backup);
        if (entry.hadOriginal) {
          expectedTargetDescriptor = openBoundPrivateFile(
            target,
            `generated target ${entry.target}`,
          );
        }
        await system.afterTargetInspect();
        if (entry.hadOriginal) {
          backupVerifiedBound(
            target,
            backup,
            heldLock.rootDescriptor,
            expectedTargetDescriptor!,
            `.schema-generation.target-preserved-${identityToken(nonce)}-${index}`,
            renameOverride,
          );
          renameBound(staged, target, renameOverride);
        } else {
          installAbsentBound(staged, target, renameOverride);
        }
      } finally {
        if (expectedTargetDescriptor !== undefined) {
          closeSync(expectedTargetDescriptor);
        }
        for (const file of files) closeBoundFile(file, heldLock.rootDescriptor);
      }
      await system.afterPromotionStep(index + 1);
    }
    writeTransaction(
      heldLock.rootDescriptor,
      { ...transaction, state: 'committed' },
      `${nonce}-committed`,
      () => {},
    );
    transactionCommitted = true;
    preserveStagingForRecovery = true;
  } catch (promotionError) {
    errors.push(promotionError);
    let shouldRecover = currentTransactionStarted;
    if (heldLock !== undefined && !shouldRecover) {
      try {
        shouldRecover =
          readTransaction(root, heldLock.rootDescriptor)?.staging ===
          stagingName;
      } catch (error) {
        preserveStagingForRecovery = true;
        errors.push(error);
      }
    }
    if (heldLock !== undefined && shouldRecover) {
      try {
        recoverTransaction(root, heldLock.rootDescriptor, renameOverride);
        preserveStagingForRecovery = false;
        transactionCommitted = false;
      } catch (error) {
        preserveStagingForRecovery = true;
        errors.push(error);
      }
    }
  }
  if (!preserveStagingForRecovery || transactionCommitted) {
    try {
      if (heldLock !== undefined) {
        assertRootIdentity(
          root,
          heldLock.rootDescriptor,
          'before staging cleanup',
        );
      }
      if (heldLock !== undefined) {
        removePinnedDirectoryTree(
          root,
          heldLock.rootDescriptor,
          stagingName,
          undefined,
          system.beforeStagingTreeRemoval,
        );
      } else {
        rmSync(stagingRoot, { recursive: true, force: true });
      }
      if (transactionCommitted && heldLock !== undefined) {
        await system.afterStagingCleanup();
        unlinkAt(heldLock.rootDescriptor, TRANSACTION_NAME);
        syncDescriptor(heldLock.rootDescriptor, 'package root after cleanup');
        preserveStagingForRecovery = false;
      }
    } catch (error) {
      errors.push(error);
    }
  }
  if (heldLock !== undefined) {
    try {
      errors.push(...(await releaseOwnedLock(root, heldLock, system)));
    } catch (error) {
      errors.push(error);
    }
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

export const generateContracts = async (
  options: PublishOptions & Readonly<{ packageRoot?: string }> = {},
): Promise<void> => {
  const packageRoot = options.packageRoot ?? resolve(import.meta.dir, '..');
  await publishGeneratedOutputs(packageRoot, createContractOutputs(), options);
};

if (import.meta.main) await generateContracts();
