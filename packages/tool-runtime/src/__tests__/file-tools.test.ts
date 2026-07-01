import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  ToolRegistry,
  ToolRunner,
  createBuiltinTools,
  createRuntimeContext,
  applyEditProposal,
  type EditProposal,
} from '../index.js';

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'colorful-tool-runtime-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('Edit requires a prior complete Read', async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, 'note.txt');
    await writeFile(file, 'hello', 'utf8');
    const runner = new ToolRunner(
      new ToolRegistry(createBuiltinTools()),
      createRuntimeContext(),
    );

    const result = await runner.run({
      id: 'edit-1',
      name: 'Edit',
      input: { path: file, oldText: 'hello', newText: 'hi' },
    });

    assert.equal(result.isError, true);
    assert.match(result.content, /read before editing/i);
  });
});

test('Read then Edit updates an exact match', async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, 'note.txt');
    await writeFile(file, 'hello world', 'utf8');
    const context = createRuntimeContext();
    const runner = new ToolRunner(
      new ToolRegistry(createBuiltinTools()),
      context,
    );

    await runner.run({ id: 'read-1', name: 'Read', input: { path: file } });
    const edit = await runner.run({
      id: 'edit-1',
      name: 'Edit',
      input: { path: file, oldText: 'hello', newText: 'hi' },
    });

    assert.equal(edit.isError, undefined);
    assert.equal(await readFile(file, 'utf8'), 'hi world');
    assert.deepEqual(edit.metadata?.patches, [
      {
        path: file,
        status: 'modified',
        added: 1,
        removed: 1,
        hunks: [
          {
            oldStart: 1,
            oldLines: 1,
            newStart: 1,
            newLines: 1,
            lines: [
              { kind: 'removed', oldNumber: 1, text: 'hello world' },
              { kind: 'added', newNumber: 1, text: 'hi world' },
            ],
          },
        ],
      },
    ]);
  });
});

test('Edit falls back to per-line whitespace-normalized matching', async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, 'note.txt');
    await writeFile(file, 'function demo() {\n    return   1;\n}\n', 'utf8');
    const context = createRuntimeContext();
    const runner = new ToolRunner(
      new ToolRegistry(createBuiltinTools()),
      context,
    );

    await runner.run({ id: 'read-1', name: 'Read', input: { path: file } });
    const edit = await runner.run({
      id: 'edit-1',
      name: 'Edit',
      input: {
        path: file,
        oldText: 'function demo() {\n  return 1;\n}',
        newText: 'function demo() {\n  return 2;\n}',
      },
    });

    assert.equal(edit.isError, undefined);
    assert.equal(
      await readFile(file, 'utf8'),
      'function demo() {\n  return 2;\n}\n',
    );
  });
});

test('Write returns structured patch metadata', async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, 'note.txt');
    const runner = new ToolRunner(
      new ToolRegistry(createBuiltinTools()),
      createRuntimeContext(),
    );

    const result = await runner.run({
      id: 'write-1',
      name: 'Write',
      input: { path: file, content: 'alpha\nbeta\n' },
    });

    assert.equal(result.isError, undefined);
    assert.deepEqual(result.metadata?.patches, [
      {
        path: file,
        status: 'added',
        added: 2,
        removed: 0,
        hunks: [
          {
            oldStart: 1,
            oldLines: 0,
            newStart: 1,
            newLines: 2,
            lines: [
              { kind: 'added', newNumber: 1, text: 'alpha' },
              { kind: 'added', newNumber: 2, text: 'beta' },
            ],
          },
        ],
      },
    ]);
  });
});

test('ProposeEdit records a patch without writing until ApplyEdit', async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, 'note.txt');
    await writeFile(file, 'hello world\n', 'utf8');
    const context = createRuntimeContext();
    const runner = new ToolRunner(
      new ToolRegistry(createBuiltinTools()),
      context,
    );

    await runner.run({ id: 'read-1', name: 'Read', input: { path: file } });
    const proposed = await runner.run({
      id: 'propose-1',
      name: 'ProposeEdit',
      input: { path: file, oldText: 'hello', newText: 'hi' },
    });

    assert.equal(proposed.isError, undefined);
    assert.equal(await readFile(file, 'utf8'), 'hello world\n');
    assert.equal(typeof proposed.metadata?.proposalId, 'string');
    assert.ok(Array.isArray(proposed.metadata?.patches));
    const proposal = context.editProposals?.get(
      proposed.metadata?.proposalId as string,
    );
    assert.ok(proposal);
    proposal.status = 'approved';

    const applied = await runner.run({
      id: 'apply-1',
      name: 'ApplyEdit',
      input: { proposalId: proposed.metadata?.proposalId },
    });

    assert.equal(applied.isError, undefined);
    assert.equal(await readFile(file, 'utf8'), 'hi world\n');
  });
});

test('ApplyEdit refuses a proposal that has not been approved', async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, 'note.txt');
    await writeFile(file, 'hello world\n', 'utf8');
    const context = createRuntimeContext();
    const runner = new ToolRunner(
      new ToolRegistry(createBuiltinTools()),
      context,
    );

    await runner.run({ id: 'read-1', name: 'Read', input: { path: file } });
    const proposed = await runner.run({
      id: 'propose-1',
      name: 'ProposeEdit',
      input: { path: file, oldText: 'hello', newText: 'hi' },
    });
    const applied = await runner.run({
      id: 'apply-1',
      name: 'ApplyEdit',
      input: { proposalId: proposed.metadata?.proposalId },
    });

    assert.equal(applied.isError, true);
    assert.match(applied.content, /must be approved/i);
    assert.equal(await readFile(file, 'utf8'), 'hello world\n');
  });
});

test('RejectEdit abandons a proposed patch without writing', async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, 'note.txt');
    await writeFile(file, 'hello world\n', 'utf8');
    const context = createRuntimeContext();
    const runner = new ToolRunner(
      new ToolRegistry(createBuiltinTools()),
      context,
    );

    await runner.run({ id: 'read-1', name: 'Read', input: { path: file } });
    const proposed = await runner.run({
      id: 'propose-1',
      name: 'ProposeEdit',
      input: { path: file, oldText: 'hello', newText: 'hi' },
    });
    const rejected = await runner.run({
      id: 'reject-1',
      name: 'RejectEdit',
      input: { proposalId: proposed.metadata?.proposalId },
    });

    assert.equal(rejected.isError, undefined);
    assert.equal(await readFile(file, 'utf8'), 'hello world\n');
  });
});

test('ApplyEdit reports a conflict when the file changed after proposal', async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, 'note.txt');
    await writeFile(file, 'hello world\n', 'utf8');
    const context = createRuntimeContext();
    const runner = new ToolRunner(
      new ToolRegistry(createBuiltinTools()),
      context,
    );

    await runner.run({ id: 'read-1', name: 'Read', input: { path: file } });
    const proposed = await runner.run({
      id: 'propose-1',
      name: 'ProposeEdit',
      input: { path: file, oldText: 'hello', newText: 'hi' },
    });
    await writeFile(file, 'external change\n', 'utf8');
    const proposal = context.editProposals?.get(
      proposed.metadata?.proposalId as string,
    );
    assert.ok(proposal);
    proposal.status = 'approved';

    const applied = await runner.run({
      id: 'apply-1',
      name: 'ApplyEdit',
      input: { proposalId: proposed.metadata?.proposalId },
    });

    assert.equal(applied.isError, true);
    assert.match(applied.content, /conflict/i);
    assert.equal(
      applied.metadata?.reason,
      'File changed since the edit was proposed.',
    );
    assert.equal(await readFile(file, 'utf8'), 'external change\n');
  });
});

test('Read returns numbered pages using one-based offset and limit', async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, 'note.txt');
    await writeFile(file, 'alpha\nbeta\ngamma\ndelta\n', 'utf8');
    const runner = new ToolRunner(
      new ToolRegistry(createBuiltinTools()),
      createRuntimeContext(),
    );

    const result = await runner.run({
      id: 'read-1',
      name: 'Read',
      input: { path: file, offset: 2, limit: 2 },
    });

    assert.equal(result.isError, undefined);
    assert.match(result.content, /Lines 2-3/);
    assert.match(result.content, /2 \| beta/);
    assert.match(result.content, /3 \| gamma/);
    assert.doesNotMatch(result.content, /1 \| alpha/);
    assert.doesNotMatch(result.content, /4 \| delta/);
  });
});

test('Read caps default output and reports when more lines are available', async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, 'long.txt');
    const content = Array.from(
      { length: 2_101 },
      (_, index) => 'line-' + (index + 1),
    ).join('\n');
    await writeFile(file, content, 'utf8');
    const runner = new ToolRunner(
      new ToolRegistry(createBuiltinTools()),
      createRuntimeContext(),
    );

    const result = await runner.run({
      id: 'read-1',
      name: 'Read',
      input: { path: file },
    });

    assert.equal(result.isError, undefined);
    assert.match(result.content, /Lines 1-200/);
    assert.match(result.content, /1 \| line-1/);
    assert.match(result.content, /200 \| line-200/);
    assert.doesNotMatch(result.content, /201 \| line-201/);
    assert.match(result.content, /truncated/i);
    assert.match(result.content, /offset: 201/);
  });
});

test('Edit rejects files changed since the last Read', async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, 'note.txt');
    await writeFile(file, 'hello', 'utf8');
    const context = createRuntimeContext();
    const runner = new ToolRunner(
      new ToolRegistry(createBuiltinTools()),
      context,
    );

    await runner.run({ id: 'read-1', name: 'Read', input: { path: file } });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await writeFile(file, 'external change', 'utf8');

    const edit = await runner.run({
      id: 'edit-1',
      name: 'Edit',
      input: { path: file, oldText: 'hello', newText: 'hi' },
    });

    assert.equal(edit.isError, true);
    assert.match(edit.content, /changed since it was read/i);
  });
});

test('filesystem sandbox rejects lexical traversal outside workspace roots', async () => {
  await withTempDir(async (dir) => {
    const workspace = join(dir, 'workspace');
    await mkdir(workspace);
    const context = createRuntimeContext({
      cwd: workspace,
      permissionContext: {
        mode: 'workspaceWrite',
        workspaceRoots: [workspace],
        rules: [],
      },
    });
    const runner = new ToolRunner(
      new ToolRegistry(createBuiltinTools()),
      context,
    );

    const result = await runner.run({
      id: 'write-traversal',
      name: 'Write',
      input: { path: '../outside.txt', content: 'nope' },
    });

    assert.equal(result.isError, true);
    assert.match(result.content, /outside the workspace roots/i);
  });
});

test('filesystem sandbox rejects symlinks that point outside workspace roots', async () => {
  await withTempDir(async (dir) => {
    const workspace = join(dir, 'workspace');
    const outside = join(dir, 'outside');
    await mkdir(workspace);
    await mkdir(outside);
    const outsideFile = join(outside, 'secret.txt');
    await writeFile(outsideFile, 'secret', 'utf8');
    const link = join(workspace, 'link.txt');
    await symlink(outsideFile, link);

    const context = createRuntimeContext({
      cwd: workspace,
      permissionContext: {
        mode: 'workspaceWrite',
        workspaceRoots: [workspace],
        rules: [],
      },
    });
    const runner = new ToolRunner(
      new ToolRegistry(createBuiltinTools()),
      context,
    );

    const read = await runner.run({
      id: 'read-symlink',
      name: 'Read',
      input: { path: link },
    });
    const write = await runner.run({
      id: 'write-symlink',
      name: 'Write',
      input: { path: link, content: 'changed' },
    });

    assert.equal(read.isError, true);
    assert.match(read.content, /outside the workspace roots/i);
    assert.equal(write.isError, true);
    assert.match(write.content, /outside the workspace roots/i);
    assert.equal(await readFile(outsideFile, 'utf8'), 'secret');
  });
});

test('filesystem sandbox rejects dangling symlink writes outside workspace roots', async () => {
  await withTempDir(async (dir) => {
    const workspace = join(dir, 'workspace');
    const outside = join(dir, 'outside');
    await mkdir(workspace);
    await mkdir(outside);
    const outsideFile = join(outside, 'created.txt');
    const link = join(workspace, 'dangling.txt');
    await symlink(outsideFile, link);

    const context = createRuntimeContext({
      cwd: workspace,
      permissionContext: {
        mode: 'workspaceWrite',
        workspaceRoots: [workspace],
        rules: [],
      },
    });
    const runner = new ToolRunner(
      new ToolRegistry(createBuiltinTools()),
      context,
    );

    const result = await runner.run({
      id: 'write-dangling-symlink',
      name: 'Write',
      input: { path: link, content: 'nope' },
    });

    assert.equal(result.isError, true);
    assert.match(result.content, /outside the workspace roots/i);
    await assert.rejects(() => stat(outsideFile));
  });
});

test('ApplyEdit rechecks the current filesystem sandbox before writing', async () => {
  await withTempDir(async (dir) => {
    const workspace = join(dir, 'workspace');
    const outside = join(dir, 'outside.txt');
    await mkdir(workspace);
    await writeFile(outside, 'before', 'utf8');
    const proposal: EditProposal = {
      id: 'proposal-outside',
      toolUseId: 'propose-outside',
      createdAt: Date.now(),
      patches: [],
      files: [
        {
          path: outside,
          before: 'before',
          after: 'after',
          requireUnchanged: true,
        },
      ],
      status: 'approved',
    };
    const context = createRuntimeContext({
      cwd: workspace,
      permissionContext: {
        mode: 'workspaceWrite',
        workspaceRoots: [workspace],
        rules: [],
      },
    });

    await assert.rejects(
      () => applyEditProposal(proposal, context),
      /outside the workspace roots/i,
    );
    assert.equal(await readFile(outside, 'utf8'), 'before');
  });
});

test('filesystem sandbox can optionally reject reads outside workspace roots', async () => {
  await withTempDir(async (dir) => {
    const workspace = join(dir, 'workspace');
    const outside = join(dir, 'outside.txt');
    await mkdir(workspace);
    await writeFile(outside, 'secret', 'utf8');
    const context = createRuntimeContext({
      cwd: workspace,
      permissionContext: {
        mode: 'default',
        workspaceRoots: [workspace],
        rules: [],
        restrictReadToWorkspace: true,
      },
    });
    const runner = new ToolRunner(
      new ToolRegistry(createBuiltinTools()),
      context,
    );

    const result = await runner.run({
      id: 'read-outside',
      name: 'Read',
      input: { path: outside },
    });

    assert.equal(result.isError, true);
    assert.match(result.content, /outside the workspace roots/i);
  });
});
