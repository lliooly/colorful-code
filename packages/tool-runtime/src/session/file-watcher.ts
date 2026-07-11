import { watch, type FSWatcher } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { RuntimeContext } from '../core/tool.js';

export type FileWatchEventType =
  | 'file_created'
  | 'file_changed'
  | 'file_deleted';

export type FileWatchEvent = {
  type: FileWatchEventType;
  path: string;
  at: number;
};

export type WorkspaceFileWatcher = {
  /** Resolves after the initial workspace snapshot has been captured. */
  ready(): Promise<void>;
  close(): Promise<void>;
};

export type WorkspaceFileWatcherOptions = {
  roots: string[];
  context?: RuntimeContext;
  onEvent: (event: FileWatchEvent) => void;
  pollIntervalMs?: number;
};

const IGNORED_DIRS = new Set(['node_modules', '.git', 'dist']);

function shouldIgnore(path: string): boolean {
  return path.split('/').some((segment) => IGNORED_DIRS.has(segment));
}

function invalidate(context: RuntimeContext | undefined, filePath: string): void {
  const snapshot = context?.fileState?.get(filePath);
  if (!snapshot) {
    return;
  }
  snapshot.stale = true;
  snapshot.complete = false;
}

async function syncLspDocument(
  context: RuntimeContext | undefined,
  event: FileWatchEvent,
): Promise<void> {
  if (
    !context?.lspManager ||
    (event.type !== 'file_created' && event.type !== 'file_changed')
  ) {
    return;
  }
  try {
    const content = await readFile(event.path, 'utf8');
    await context.lspManager.didChange(event.path, content);
  } catch {
    // File watching is advisory. LSP sync must not break the session stream.
  }
}

export function createWorkspaceFileWatcher(
  options: WorkspaceFileWatcherOptions,
): WorkspaceFileWatcher {
  const watchers = new Map<string, FSWatcher>();
  const knownFiles = new Map<string, number>();
  const pollTimers = new Set<NodeJS.Timeout>();
  let closed = false;

  const emit = (event: FileWatchEvent) => {
    if (shouldIgnore(event.path)) {
      return;
    }
    invalidate(options.context, event.path);
    void syncLspDocument(options.context, event);
    options.onEvent(event);
  };

  const observeFile = (filePath: string, mtimeMs: number): void => {
    const previous = knownFiles.get(filePath);
    knownFiles.set(filePath, mtimeMs);
    if (previous === undefined) {
      emit({ type: 'file_created', path: filePath, at: Date.now() });
      return;
    }
    if (previous !== mtimeMs) {
      emit({ type: 'file_changed', path: filePath, at: Date.now() });
    }
  };

  const observeDelete = (filePath: string): void => {
    if (knownFiles.delete(filePath)) {
      emit({ type: 'file_deleted', path: filePath, at: Date.now() });
    }
  };

  const watchDir = (dir: string): void => {
    if (closed || watchers.has(dir) || shouldIgnore(dir)) {
      return;
    }
    try {
      const watcher = watch(dir, (eventType, filename) => {
        if (!filename) {
          return;
        }
        const filePath = resolve(dir, filename.toString());
        if (shouldIgnore(filePath)) {
          return;
        }
        void (async () => {
          try {
            const stats = await stat(filePath);
            if (stats.isDirectory()) {
              watchDir(filePath);
              return;
            }
            observeFile(filePath, stats.mtimeMs);
          } catch {
            observeDelete(filePath);
          }
        })();
      });
      watcher.on('error', () => undefined);
      watchers.set(dir, watcher);
    } catch {
      // A watcher is best-effort; unreadable directories should not break the
      // session.
    }
  };

  const scan = async (dir: string): Promise<void> => {
    if (closed || shouldIgnore(dir)) {
      return;
    }
    watchDir(dir);
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    await Promise.all(
      entries.map(async (entry) => {
        const path = join(dir, entry.name);
        if (shouldIgnore(path)) {
          return;
        }
        if (entry.isDirectory()) {
          await scan(path);
          return;
        }
        try {
          const stats = await stat(path);
          knownFiles.set(resolve(path), stats.mtimeMs);
        } catch {
          // Ignore races with deletion.
        }
      }),
    );
  };

  const absoluteRoots = options.roots.map((root) => resolve(root));
  const initialScan = Promise.all(absoluteRoots.map((root) => scan(root))).then(
    () => undefined,
  );

  for (const absoluteRoot of absoluteRoots) {
    const timer = setInterval(() => {
      const before = new Set(knownFiles.keys());
      void (async () => {
        const seen = new Set<string>();
        await scanPoll(absoluteRoot, seen);
        for (const filePath of before) {
          if (filePath.startsWith(absoluteRoot + '/') && !seen.has(filePath)) {
            observeDelete(filePath);
          }
        }
      })();
    }, options.pollIntervalMs ?? 50);
    pollTimers.add(timer);
  }

  async function scanPoll(dir: string, seen: Set<string>): Promise<void> {
    if (closed || shouldIgnore(dir)) {
      return;
    }
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    await Promise.all(
      entries.map(async (entry) => {
        const path = join(dir, entry.name);
        if (shouldIgnore(path)) {
          return;
        }
        if (entry.isDirectory()) {
          await scanPoll(path, seen);
          return;
        }
        const filePath = resolve(path);
        seen.add(filePath);
        try {
          const stats = await stat(path);
          observeFile(filePath, stats.mtimeMs);
        } catch {
          observeDelete(filePath);
        }
      }),
    );
  }

  return {
    async ready() {
      await initialScan;
    },
    async close() {
      closed = true;
      for (const timer of pollTimers) {
        clearInterval(timer);
      }
      pollTimers.clear();
      for (const watcher of watchers.values()) {
        watcher.close();
      }
      watchers.clear();
    },
  };
}
