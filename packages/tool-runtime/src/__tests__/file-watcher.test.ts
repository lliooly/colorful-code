import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  Session,
  ToolRegistry,
  ToolRunner,
  createBuiltinTools,
  createRuntimeContext,
  createScriptedModelClient,
  createWorkspaceFileWatcher,
  type FileWatchEvent,
  type LspManager,
  type SessionEvent,
} from '../index.js';

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'colorful-file-watch-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function waitFor(
  predicate: () => boolean,
  label: string,
  attempts = 80,
): Promise<void> {
  for (let index = 0; index < attempts; index += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail('timed out waiting for: ' + label);
}

test('workspace watcher emits create, change, and delete events while ignoring common build directories', async () => {
  await withTempDir(async (dir) => {
    const events: FileWatchEvent[] = [];
    const watcher = createWorkspaceFileWatcher({
      roots: [dir],
      onEvent: (event) => events.push(event),
    });
    try {
      const file = join(dir, 'note.txt');
      await writeFile(file, 'one', 'utf8');
      await waitFor(
        () => events.some((event) => event.type === 'file_created'),
        'file_created',
      );

      await writeFile(file, 'two', 'utf8');
      await waitFor(
        () => events.some((event) => event.type === 'file_changed'),
        'file_changed',
      );

      await mkdir(join(dir, 'node_modules'), { recursive: true });
      await writeFile(join(dir, 'node_modules', 'ignored.txt'), 'x', 'utf8');
      await new Promise((resolve) => setTimeout(resolve, 75));
      assert.equal(
        events.some((event) => event.path.includes('node_modules')),
        false,
      );

      await unlink(file);
      await waitFor(
        () => events.some((event) => event.type === 'file_deleted'),
        'file_deleted',
      );
    } finally {
      await watcher.close();
    }
  });
});

test('file watch invalidation makes Edit require a fresh Read after external change', async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, 'note.txt');
    await writeFile(file, 'hello world\n', 'utf8');
    const context = createRuntimeContext({ cwd: dir });
    const runner = new ToolRunner(
      new ToolRegistry(createBuiltinTools()),
      context,
    );
    const watcher = createWorkspaceFileWatcher({
      roots: [dir],
      context,
      onEvent: () => undefined,
    });
    try {
      await runner.run({ id: 'read-1', name: 'Read', input: { path: file } });
      await writeFile(file, 'external world\n', 'utf8');
      await waitFor(
        () => context.fileState?.get(file)?.stale === true,
        'fileState stale',
      );

      const edit = await runner.run({
        id: 'edit-1',
        name: 'Edit',
        input: { path: file, oldText: 'external', newText: 'internal' },
      });

      assert.equal(edit.isError, true);
      assert.match(edit.content, /read it again/i);
    } finally {
      await watcher.close();
    }
  });
});

test('workspace watcher syncs external file changes to the LSP manager', async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, 'note.ts');
    const changes: Array<{ file: string; content: string }> = [];
    const lspManager: LspManager = {
      async initialize() {
        return [];
      },
      async goToDefinition() {
        return [];
      },
      async findReferences() {
        return [];
      },
      async getDiagnostics() {
        return [];
      },
      async hover() {
        return null;
      },
      async documentSymbols() {
        return [];
      },
      async workspaceSymbol() {
        return [];
      },
      async didChange(changedFile, content) {
        changes.push({ file: changedFile, content });
      },
      async close() {},
    };
    const context = createRuntimeContext({ cwd: dir, lspManager });
    const watcher = createWorkspaceFileWatcher({
      roots: [dir],
      context,
      onEvent: () => undefined,
    });
    try {
      await writeFile(file, 'export const answer = 42;\n', 'utf8');
      await waitFor(
        () =>
          changes.some(
            (change) =>
              change.file === file &&
              change.content === 'export const answer = 42;\n',
          ),
        'lsp didChange',
      );
    } finally {
      await watcher.close();
    }
  });
});

test('Session emits file watch events for configured workspace roots', async () => {
  await withTempDir(async (dir) => {
    const session = new Session({
      model: createScriptedModelClient([[{ type: 'text', text: 'idle' }]]),
      tools: createBuiltinTools(),
      cwd: dir,
      watchWorkspace: true,
    });
    const events: SessionEvent[] = [];
    session.subscribe((event) => events.push(event));

    const file = join(dir, 'note.txt');
    await writeFile(file, 'hello', 'utf8');
    await waitFor(
      () => events.some((event) => event.type === 'file_created'),
      'session file_created event',
    );

    assert.ok(
      events.some(
        (event) => event.type === 'file_created' && event.path === file,
      ),
    );
    await session.close();
  });
});
