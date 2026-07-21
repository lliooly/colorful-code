/// <reference types="node" />

import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  writeFileSync,
  type Stats,
} from 'node:fs';
import { basename, resolve } from 'node:path';

const outcomes = [
  'accept',
  'reject',
  'known',
  'unknownNonCritical',
  'resetRequired',
  'protocolError',
] as const;
const MAX_CONFORMANCE_OUTPUT_BYTES = 4 * 1024 * 1024;

export type ConformanceOutcome = (typeof outcomes)[number];

export type ConformanceRecord = Readonly<{
  id: string;
  outcome: ConformanceOutcome;
}>;

export type ConformanceOutputHooks = Readonly<{
  afterOutputOpen?: () => void;
  afterRootOpen?: () => void;
  beforeFailedOutputUnlink?: () => void;
  beforeOutputOpen?: () => void;
}>;

const outcomeSet = new Set<string>(outcomes);

const invalidJsonLines = (): never => {
  throw new TypeError('invalid conformance JSONL');
};

export const completeConformanceOutput = (
  succeeded: boolean,
  cleanup: readonly (() => void)[],
): void => {
  let failed = !succeeded;
  for (const action of cleanup) {
    try {
      action();
    } catch {
      failed = true;
    }
  }
  if (failed) throw new TypeError('invalid conformance output');
};

export const compareConformanceIds = (left: string, right: string): number => {
  const leftBytes = Buffer.from(left, 'utf8');
  const rightBytes = Buffer.from(right, 'utf8');
  const length = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    const difference = leftBytes[index]! - rightBytes[index]!;
    if (difference !== 0) return difference;
  }
  return leftBytes.length - rightBytes.length;
};

const canonicalRecord = (record: ConformanceRecord): string =>
  JSON.stringify({ id: record.id, outcome: record.outcome });

const validateRecord = (value: unknown): ConformanceRecord => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return invalidJsonLines();
  }
  const keys = Object.keys(value);
  if (keys.length !== 2 || keys[0] !== 'id' || keys[1] !== 'outcome') {
    return invalidJsonLines();
  }
  const id = Reflect.get(value, 'id');
  const outcome = Reflect.get(value, 'outcome');
  if (
    typeof id !== 'string' ||
    id.length === 0 ||
    id.trim() !== id ||
    typeof outcome !== 'string' ||
    !outcomeSet.has(outcome)
  ) {
    return invalidJsonLines();
  }
  return Object.freeze({ id, outcome: outcome as ConformanceOutcome });
};

const validateRecordOrder = (
  records: readonly ConformanceRecord[],
): readonly ConformanceRecord[] => {
  let previous: string | undefined;
  for (const record of records) {
    const validated = validateRecord(record);
    if (
      previous !== undefined &&
      compareConformanceIds(previous, validated.id) >= 0
    ) {
      return invalidJsonLines();
    }
    previous = validated.id;
  }
  return records;
};

export const parseConformanceJsonLines = (
  source: string,
): readonly ConformanceRecord[] => {
  if (source.length === 0 || !source.endsWith('\n')) {
    return invalidJsonLines();
  }
  const lines = source.slice(0, -1).split('\n');
  if (lines.some((line) => line.length === 0)) return invalidJsonLines();
  const records = lines.map((line) => {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      return invalidJsonLines();
    }
    const record = validateRecord(value);
    if (canonicalRecord(record) !== line) return invalidJsonLines();
    return record;
  });
  validateRecordOrder(records);
  return Object.freeze(records);
};

export const serializeConformanceJsonLines = (
  input: readonly ConformanceRecord[],
): string => {
  const records = input
    .map(validateRecord)
    .sort((left, right) => compareConformanceIds(left.id, right.id));
  if (records.length === 0) return invalidJsonLines();
  validateRecordOrder(records);
  return `${records.map(canonicalRecord).join('\n')}\n`;
};

export const compareConformanceRecords = (
  typescript: readonly ConformanceRecord[],
  swift: readonly ConformanceRecord[],
): void => {
  validateRecordOrder(typescript);
  validateRecordOrder(swift);
  if (
    typescript.length === 0 ||
    typescript.length !== swift.length ||
    typescript.some(
      (record, index) =>
        record.id !== swift[index]?.id ||
        record.outcome !== swift[index]?.outcome,
    )
  ) {
    throw new TypeError('conformance result mismatch');
  }
};

const outputOpenFlags = (): number => {
  let flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL;
  for (const name of ['O_NOFOLLOW', 'O_CLOEXEC']) {
    const flag = Reflect.get(constants, name);
    if (typeof flag === 'number') flags |= flag;
  }
  return flags;
};

const outputReadFlags = (): number => {
  let flags = constants.O_RDONLY;
  for (const name of ['O_NOFOLLOW', 'O_CLOEXEC']) {
    const flag = Reflect.get(constants, name);
    if (typeof flag === 'number') flags |= flag;
  }
  return flags;
};

const directoryOpenFlags = (): number => {
  let flags = constants.O_RDONLY;
  for (const name of ['O_DIRECTORY', 'O_NOFOLLOW', 'O_CLOEXEC']) {
    const flag = Reflect.get(constants, name);
    if (typeof flag === 'number') flags |= flag;
  }
  return flags;
};

type DirectoryIdentity = Readonly<{
  dev: number;
  ino: number;
  mode: number;
  uid: number;
}>;

type OpenOutputRoot = Readonly<{
  descriptor: number;
  identity: DirectoryIdentity;
  path: string;
}>;

const directoryIdentity = (metadata: Stats): DirectoryIdentity =>
  Object.freeze({
    dev: metadata.dev,
    ino: metadata.ino,
    mode: metadata.mode,
    uid: metadata.uid,
  });

const sameDirectoryIdentity = (
  left: DirectoryIdentity,
  right: DirectoryIdentity,
): boolean =>
  left.dev === right.dev &&
  left.ino === right.ino &&
  left.mode === right.mode &&
  left.uid === right.uid;

const openPrivateOutputRoot = (root: string): OpenOutputRoot => {
  const initial = lstatSync(root);
  if (
    !initial.isDirectory() ||
    initial.isSymbolicLink() ||
    (initial.mode & 0o077) !== 0 ||
    (typeof process.getuid === 'function' && initial.uid !== process.getuid())
  ) {
    throw new TypeError('invalid conformance output');
  }
  const path = realpathSync(root);
  const descriptor = openSync(path, directoryOpenFlags());
  try {
    const opened = fstatSync(descriptor);
    const current = lstatSync(path);
    const initialIdentity = directoryIdentity(initial);
    if (
      !opened.isDirectory() ||
      !current.isDirectory() ||
      current.isSymbolicLink() ||
      !sameDirectoryIdentity(initialIdentity, directoryIdentity(opened)) ||
      !sameDirectoryIdentity(initialIdentity, directoryIdentity(current))
    ) {
      throw new TypeError('invalid conformance output');
    }
    return Object.freeze({
      descriptor,
      identity: initialIdentity,
      path,
    });
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
};

const assertOutputRootCurrent = (root: OpenOutputRoot): void => {
  const descriptor = fstatSync(root.descriptor);
  const path = lstatSync(root.path);
  if (
    !descriptor.isDirectory() ||
    !path.isDirectory() ||
    path.isSymbolicLink() ||
    !sameDirectoryIdentity(root.identity, directoryIdentity(descriptor)) ||
    !sameDirectoryIdentity(root.identity, directoryIdentity(path)) ||
    realpathSync(root.path) !== root.path
  ) {
    throw new TypeError('invalid conformance output');
  }
};

const conformanceOutputPath = (root: string, name: string): string => {
  if (
    name.length === 0 ||
    name === '.' ||
    name === '..' ||
    basename(name) !== name ||
    name.includes('\\')
  ) {
    throw new TypeError('invalid conformance output');
  }
  return resolve(root, name);
};

export const writeConformanceJsonLines = (
  outputRoot: string,
  outputName: string,
  records: readonly ConformanceRecord[],
  hooks: ConformanceOutputHooks = {},
): string => {
  let root: OpenOutputRoot | undefined;
  let path: string | undefined;
  let descriptor: number | undefined;
  let succeeded = false;
  let result: string | undefined;
  try {
    root = openPrivateOutputRoot(outputRoot);
    hooks.afterRootOpen?.();
    assertOutputRootCurrent(root);
    path = conformanceOutputPath(root.path, outputName);
    const source = serializeConformanceJsonLines(records);
    if (Buffer.byteLength(source) > MAX_CONFORMANCE_OUTPUT_BYTES) {
      throw new TypeError('invalid conformance output');
    }
    hooks.beforeOutputOpen?.();
    descriptor = openSync(path, outputOpenFlags(), 0o600);
    const before = fstatSync(descriptor);
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      (typeof process.getuid === 'function' && before.uid !== process.getuid())
    ) {
      throw new TypeError('invalid conformance output');
    }
    fchmodSync(descriptor, 0o600);
    const secured = fstatSync(descriptor);
    if (
      secured.dev !== before.dev ||
      secured.ino !== before.ino ||
      (secured.mode & 0o777) !== 0o600
    ) {
      throw new TypeError('invalid conformance output');
    }
    hooks.afterOutputOpen?.();
    assertOutputRootCurrent(root);
    writeFileSync(descriptor, source, 'utf8');
    fsyncSync(descriptor);
    const after = fstatSync(descriptor);
    const pathAfter = lstatSync(path);
    if (
      !after.isFile() ||
      after.nlink !== 1 ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== Buffer.byteLength(source) ||
      after.uid !== before.uid ||
      (after.mode & 0o777) !== 0o600 ||
      !pathAfter.isFile() ||
      pathAfter.isSymbolicLink() ||
      pathAfter.nlink !== 1 ||
      pathAfter.dev !== after.dev ||
      pathAfter.ino !== after.ino ||
      pathAfter.size !== after.size ||
      pathAfter.uid !== after.uid ||
      (pathAfter.mode & 0o777) !== 0o600
    ) {
      throw new TypeError('invalid conformance output');
    }
    assertOutputRootCurrent(root);
    succeeded = true;
    result = path;
  } catch {
    succeeded = false;
  }
  const cleanup: Array<() => void> = [];
  if (!succeeded && descriptor !== undefined) {
    cleanup.push(() => {
      ftruncateSync(descriptor, 0);
      fsyncSync(descriptor);
    });
  }
  if (descriptor !== undefined) cleanup.push(() => closeSync(descriptor));
  if (!succeeded && descriptor !== undefined) {
    cleanup.push(() => hooks.beforeFailedOutputUnlink?.());
  }
  if (root !== undefined) cleanup.push(() => closeSync(root.descriptor));
  completeConformanceOutput(succeeded, cleanup);
  if (result === undefined) throw new TypeError('invalid conformance output');
  return result;
};

export const readConformanceJsonLines = (
  outputRoot: string,
  outputName: string,
  hooks: Pick<ConformanceOutputHooks, 'afterRootOpen'> = {},
): readonly ConformanceRecord[] => {
  let root: OpenOutputRoot | undefined;
  let descriptor: number | undefined;
  try {
    root = openPrivateOutputRoot(outputRoot);
    hooks.afterRootOpen?.();
    assertOutputRootCurrent(root);
    const path = conformanceOutputPath(root.path, outputName);
    const before = lstatSync(path, { bigint: true });
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.nlink !== 1n ||
      before.size > BigInt(MAX_CONFORMANCE_OUTPUT_BYTES) ||
      (before.mode & 0o777n) !== 0o600n ||
      (typeof process.getuid === 'function' &&
        before.uid !== BigInt(process.getuid()))
    ) {
      throw new TypeError('invalid conformance output');
    }
    descriptor = openSync(path, outputReadFlags());
    const opened = fstatSync(descriptor, { bigint: true });
    if (
      !opened.isFile() ||
      opened.nlink !== 1n ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== before.size ||
      opened.uid !== before.uid ||
      opened.mode !== before.mode
    ) {
      throw new TypeError('invalid conformance output');
    }
    const bytes = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(
        descriptor,
        bytes,
        offset,
        bytes.length - offset,
        null,
      );
      if (count === 0) throw new TypeError('invalid conformance output');
      offset += count;
    }
    if (readSync(descriptor, Buffer.alloc(1), 0, 1, null) !== 0) {
      throw new TypeError('invalid conformance output');
    }
    const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const after = fstatSync(descriptor, { bigint: true });
    const pathAfter = lstatSync(path, { bigint: true });
    if (
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.size !== opened.size ||
      after.mode !== opened.mode ||
      after.uid !== opened.uid ||
      after.nlink !== 1n ||
      after.mtimeNs !== opened.mtimeNs ||
      after.ctimeNs !== opened.ctimeNs ||
      pathAfter.dev !== opened.dev ||
      pathAfter.ino !== opened.ino ||
      pathAfter.size !== opened.size ||
      pathAfter.mode !== opened.mode ||
      pathAfter.uid !== opened.uid ||
      pathAfter.nlink !== 1n ||
      pathAfter.mtimeNs !== opened.mtimeNs ||
      pathAfter.ctimeNs !== opened.ctimeNs ||
      pathAfter.isSymbolicLink()
    ) {
      throw new TypeError('invalid conformance output');
    }
    assertOutputRootCurrent(root);
    return parseConformanceJsonLines(source);
  } catch {
    throw new TypeError('invalid conformance output');
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (root !== undefined) closeSync(root.descriptor);
  }
};
