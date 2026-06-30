import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import {
  BashTool,
  ToolRegistry,
  ToolRunner,
  createBuiltinTools,
  createRuntimeContext,
} from '../index.js';

const EXPECTED_TOOL_NAMES = [
  'Agent',
  'TaskOutput',
  'Bash',
  'Glob',
  'Grep',
  'ExitPlanMode',
  'Read',
  'Edit',
  'Write',
  'NotebookEdit',
  'WebFetch',
  'TodoWrite',
  'WebSearch',
  'TaskStop',
  'AskUserQuestion',
  'Skill',
  'EnterPlanMode',
  'Config',
  'TaskCreate',
  'TaskGet',
  'TaskUpdate',
  'TaskList',
  'EnterWorktree',
  'ExitWorktree',
  'SendMessage',
  'TeamCreate',
  'TeamDelete',
  'VerifyPlanExecution',
  'Sleep',
  'CronCreate',
  'CronDelete',
  'CronList',
  'SendUserMessage',
  'PowerShell',
  'Snip',
  'ListMcpResourcesTool',
  'ReadMcpResourceTool',
  'ToolSearch',
  'StructuredOutput',
  'McpAuth',
  'WebBrowser',
];

const STUB_TOOL_NAMES = [
  'LSP',
  'REPL',
  'Workflow',
  'RemoteTrigger',
  'Monitor',
  'PushNotification',
  'SubscribePR',
  'SendUserFile',
  'TestingPermission',
  'TerminalCapture',
  'CtxInspect',
  'ListPeers',
  'SuggestBackgroundPR',
  'OverflowTestTool',
  'Tungsten',
];

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'colorful-expanded-tools-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('createBuiltinTools registers runnable clean-room versions of the built-in tool set', () => {
  const registry = new ToolRegistry(createBuiltinTools());
  for (const name of EXPECTED_TOOL_NAMES) {
    assert.ok(registry.get(name), 'missing tool ' + name);
  }
});

test('createBuiltinTools does not expose placeholder stub tools to the model', () => {
  const registry = new ToolRegistry(createBuiltinTools());
  for (const name of STUB_TOOL_NAMES) {
    assert.equal(registry.get(name), undefined, 'stub tool registered: ' + name);
  }
});

test('Bash does not treat complex shell syntax as read-only', () => {
  const commands = [
    'git status && touch x',
    'git status > status.txt',
    'echo $(touch x)',
    'FOO=bar git status',
  ];

  for (const command of commands) {
    const input = BashTool.inputSchema.parse({ command });
    assert.equal(BashTool.isReadOnly(input), false, command);
    assert.equal(BashTool.isConcurrencySafe(input), false, command);
  }
});

test('Bash marks non-read-only commands as destructive for default approval', () => {
  const input = BashTool.inputSchema.parse({ command: 'rm -rf tmp' });

  assert.equal(BashTool.isReadOnly(input), false);
  assert.equal(BashTool.isDestructive(input), true);
});

test('Bash keeps captured stdout bounded while a command is running', async () => {
  const input = BashTool.inputSchema.parse({
    command: 'node -e "process.stdout.write(\'x\'.repeat(50000))"',
  });

  const result = await BashTool.call(input, createRuntimeContext());

  assert.equal(result.data.code, 0);
  assert.ok(result.data.stdout.length < 25_000);
  assert.match(result.data.stdout, /truncated/);
});

test('Bash can start a long-running command in the background', async () => {
  await withTempDir(async (dir) => {
    const input = BashTool.inputSchema.parse({
      command: 'node -e "setTimeout(() => {}, 500)"',
      run_in_background: true,
      timeoutMs: 20,
    });
    const context = createRuntimeContext({ cwd: dir }) as ReturnType<
      typeof createRuntimeContext
    > & {
      backgroundProcesses?: Map<string, unknown>;
    };

    const result = await BashTool.call(input, context);
    const mapped = BashTool.mapResult(result.data, 'bash-bg');

    assert.equal(result.data.code, null);
    assert.match(result.data.stdout, /Background command started: bash-1/);
    assert.equal(mapped.isError, undefined);
    assert.doesNotMatch(mapped.content, /Exit code null/);
    assert.equal(context.backgroundProcesses?.size, 1);
  });
});

test('Bash records a notification when a background command completes', async () => {
  const input = BashTool.inputSchema.parse({
    command: 'node -e "setTimeout(() => process.stdout.write(\'done\'), 10)"',
    run_in_background: true,
  });
  const context = createRuntimeContext();

  await BashTool.call(input, context);
  await delay(100);

  const process = context.backgroundProcesses?.get('bash-1');
  assert.equal(process?.status, 'exited');
  assert.equal(process?.stdout, 'done');
  assert.ok(
    context.notifications?.some((notification) =>
      notification.includes('Background command completed: bash-1'),
    ),
  );
});

test('TodoWrite stores a visible todo list in runtime context', async () => {
  const context = createRuntimeContext();
  const runner = new ToolRunner(
    new ToolRegistry(createBuiltinTools()),
    context,
  );

  const result = await runner.run({
    id: 'todo-1',
    name: 'TodoWrite',
    input: {
      todos: [
        { id: '1', content: 'Map tools', status: 'completed' },
        { id: '2', content: 'Implement tools', status: 'in_progress' },
      ],
    },
  });

  assert.equal(result.isError, undefined);
  assert.equal(context.todos?.length, 2);
  assert.match(result.content, /2 todos/);
});

test('Agent, SendMessage, TaskOutput, TaskGet, TaskList, TaskUpdate, and TaskStop share task state', async () => {
  const context = createRuntimeContext();
  const runner = new ToolRunner(
    new ToolRegistry(createBuiltinTools()),
    context,
  );

  const created = await runner.run({
    id: 'agent-1',
    name: 'Agent',
    input: {
      description: 'Review code',
      prompt: 'Look for risks',
      subagent_type: 'reviewer',
    },
  });
  assert.equal(created.isError, undefined);
  const taskId = context.tasks?.values().next().value?.id;
  assert.equal(typeof taskId, 'string');

  await runner.run({
    id: 'send-1',
    name: 'SendMessage',
    input: { to: taskId, message: 'continue' },
  });
  await runner.run({
    id: 'update-1',
    name: 'TaskUpdate',
    input: { id: taskId, status: 'completed', output: 'looks good' },
  });
  const output = await runner.run({
    id: 'output-1',
    name: 'TaskOutput',
    input: { id: taskId },
  });
  const got = await runner.run({
    id: 'get-1',
    name: 'TaskGet',
    input: { id: taskId },
  });
  const listed = await runner.run({
    id: 'list-1',
    name: 'TaskList',
    input: {},
  });
  const stopped = await runner.run({
    id: 'stop-1',
    name: 'TaskStop',
    input: { id: taskId },
  });

  assert.match(output.content, /looks good/);
  assert.match(got.content, /completed/);
  assert.match(listed.content, /Review code/);
  assert.match(stopped.content, /stopped/i);
});

test('MCP resource tools list and read resources from context', async () => {
  const context = createRuntimeContext({
    mcpResources: new Map([
      [
        'docs://intro',
        { uri: 'docs://intro', name: 'Intro', content: 'hello MCP' },
      ],
    ]),
  });
  const runner = new ToolRunner(
    new ToolRegistry(createBuiltinTools()),
    context,
  );

  const listed = await runner.run({
    id: 'mcp-list',
    name: 'ListMcpResourcesTool',
    input: {},
  });
  const read = await runner.run({
    id: 'mcp-read',
    name: 'ReadMcpResourceTool',
    input: { uri: 'docs://intro' },
  });

  assert.ok(listed.content.includes('docs://intro'));
  assert.match(read.content, /hello MCP/);
});

test('CronCreate, CronList, and CronDelete manage scheduled jobs', async () => {
  const context = createRuntimeContext();
  const runner = new ToolRunner(
    new ToolRegistry(createBuiltinTools()),
    context,
  );

  await runner.run({
    id: 'cron-create',
    name: 'CronCreate',
    input: { name: 'daily', schedule: '0 9 * * *', prompt: 'check status' },
  });
  const jobId = context.cronJobs?.values().next().value?.id;
  const listed = await runner.run({
    id: 'cron-list',
    name: 'CronList',
    input: {},
  });
  const deleted = await runner.run({
    id: 'cron-delete',
    name: 'CronDelete',
    input: { id: jobId },
  });

  assert.match(listed.content, /daily/);
  assert.match(deleted.content, /deleted/i);
});

test('NotebookEdit updates a notebook cell', async () => {
  await withTempDir(async (dir) => {
    const notebook = join(dir, 'demo.ipynb');
    await writeFile(
      notebook,
      JSON.stringify({
        cells: [{ cell_type: 'code', source: ['old'] }],
        metadata: {},
        nbformat: 4,
        nbformat_minor: 5,
      }),
      'utf8',
    );
    const runner = new ToolRunner(
      new ToolRegistry(createBuiltinTools()),
      createRuntimeContext(),
    );

    const result = await runner.run({
      id: 'nb-1',
      name: 'NotebookEdit',
      input: { path: notebook, cellIndex: 0, source: "print('new')" },
    });

    const parsed = JSON.parse(await readFile(notebook, 'utf8'));
    assert.equal(result.isError, undefined);
    assert.deepEqual(parsed.cells[0].source, ["print('new')"]);
  });
});
