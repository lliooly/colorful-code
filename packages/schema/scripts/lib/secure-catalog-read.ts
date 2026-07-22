/// <reference types="node" />

import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  type BigIntStats,
} from 'node:fs';

import { isWithin } from './fixture-manifest.js';

const MAX_CATALOG_FILE_BYTES = 4n * 1024n * 1024n;

export type SecureCatalogReadHooks = Readonly<{
  afterPathCheck?: (path: string) => void;
  afterRead?: (path: string) => void;
}>;

export type CatalogFileFingerprint = Readonly<{
  ctimeNs: bigint;
  dev: bigint;
  ino: bigint;
  mode: bigint;
  mtimeNs: bigint;
  nlink: bigint;
  size: bigint;
}>;

export const catalogFileFingerprint = (
  metadata: BigIntStats,
): CatalogFileFingerprint =>
  Object.freeze({
    ctimeNs: metadata.ctimeNs,
    dev: metadata.dev,
    ino: metadata.ino,
    mode: metadata.mode,
    mtimeNs: metadata.mtimeNs,
    nlink: metadata.nlink,
    size: metadata.size,
  });

export const sameCatalogFileFingerprint = (
  left: CatalogFileFingerprint,
  right: CatalogFileFingerprint,
): boolean =>
  left.ctimeNs === right.ctimeNs &&
  left.dev === right.dev &&
  left.ino === right.ino &&
  left.mode === right.mode &&
  left.mtimeNs === right.mtimeNs &&
  left.nlink === right.nlink &&
  left.size === right.size;

const checkedPathMetadata = (
  root: string,
  path: string,
  expectedCanonicalPath?: string,
): Readonly<{
  canonicalPath: string;
  fingerprint: CatalogFileFingerprint;
}> => {
  const metadata = lstatSync(path, { bigint: true });
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.nlink !== 1n
  ) {
    throw new TypeError('catalog path is not a regular file');
  }
  const canonicalPath = realpathSync(path);
  if (
    !isWithin(root, canonicalPath) ||
    (expectedCanonicalPath !== undefined &&
      canonicalPath !== expectedCanonicalPath)
  ) {
    throw new TypeError('catalog path changed');
  }
  return {
    canonicalPath,
    fingerprint: catalogFileFingerprint(metadata),
  };
};

export const inspectSecureCatalogFile = (
  root: string,
  path: string,
): CatalogFileFingerprint => checkedPathMetadata(root, path).fingerprint;

const openFlags = (): number => {
  let flags = constants.O_RDONLY;
  for (const name of ['O_NOFOLLOW', 'O_CLOEXEC']) {
    const flag = Reflect.get(constants, name);
    if (typeof flag === 'number') flags |= flag;
  }
  return flags;
};

export const readSecureCatalogFile = (
  root: string,
  path: string,
  hooks: SecureCatalogReadHooks = {},
  expectedFingerprint?: CatalogFileFingerprint,
): Readonly<{ fingerprint: CatalogFileFingerprint; source: string }> => {
  const before = checkedPathMetadata(root, path);
  if (
    expectedFingerprint !== undefined &&
    !sameCatalogFileFingerprint(before.fingerprint, expectedFingerprint)
  ) {
    throw new TypeError('catalog file does not match inventory');
  }
  hooks.afterPathCheck?.(path);

  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, openFlags());
    const opened = fstatSync(descriptor, { bigint: true });
    const openedFingerprint = catalogFileFingerprint(opened);
    if (
      !opened.isFile() ||
      opened.nlink !== 1n ||
      opened.size > MAX_CATALOG_FILE_BYTES ||
      !sameCatalogFileFingerprint(before.fingerprint, openedFingerprint)
    ) {
      throw new TypeError('catalog file changed before open');
    }
    const beforeRead = checkedPathMetadata(root, path, before.canonicalPath);
    if (
      !sameCatalogFileFingerprint(beforeRead.fingerprint, openedFingerprint)
    ) {
      throw new TypeError('catalog file changed before read');
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
      if (count === 0) throw new TypeError('catalog file ended during read');
      offset += count;
    }
    if (readSync(descriptor, Buffer.alloc(1), 0, 1, null) !== 0) {
      throw new TypeError('catalog file grew during read');
    }
    const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    hooks.afterRead?.(path);

    const afterRead = checkedPathMetadata(root, path, before.canonicalPath);
    const afterReadDescriptor = catalogFileFingerprint(
      fstatSync(descriptor, { bigint: true }),
    );
    if (
      !sameCatalogFileFingerprint(afterRead.fingerprint, openedFingerprint) ||
      !sameCatalogFileFingerprint(afterReadDescriptor, openedFingerprint)
    ) {
      throw new TypeError('catalog file changed after read');
    }
    return Object.freeze({ fingerprint: openedFingerprint, source });
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
};
