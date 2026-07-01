import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Session,
  ToolRegistry,
  ToolRunner,
  buildTool,
  createRuntimeContext,
  loadHookConfig,
  objectSchema,
  stringField,
  type HookAuditEntry,
  type HookConfig,
  type SessionEvent,
} from '../index.js';

const valueTool = buildTool({
  name: 'ValueTool',
  inputSchema: objectSchema({ value: stringField() }),
  async call(input) {
    return { data: input.value };
  },
  mapResult(data, toolUseId) {
    return { toolUseId, content: data };
  },
});

test('preToolUse hooks can modify input and append audit entries', async () => {
  const hookAudit: HookAuditEntry[] = [];
  const config: HookConfig = {
    allowlist: ['rewrite-value'],
    timeoutMs: 100,
    failurePolicy: 'fail-closed',
    hooks: [
      {
        id: 'rewrite-value',
        event: 'preToolUse',
        run: () => ({
          action: 'modifyInput',
          input: { value: 'rewritten' },
          message: 'rewrote tool input',
        }),
      },
    ],
  };
  const context = createRuntimeContext({ hookConfig: config, hookAudit });
  const runner = new ToolRunner(new ToolRegistry([valueTool]), context);

  const result = await runner.run({
    id: 'tool-1',
    name: 'ValueTool',
    input: { value: 'original' },
  });

  assert.equal(result.isError, undefined);
  assert.equal(result.content, 'rewritten');
  assert.equal(hookAudit.length, 1);
  assert.equal(hookAudit[0]?.hookId, 'rewrite-value');
  assert.equal(hookAudit[0]?.event, 'preToolUse');
  assert.equal(hookAudit[0]?.action, 'modifyInput');
});

test('preToolUse hooks can deny a tool before it runs', async () => {
  let called = false;
  const tool = buildTool({
    name: 'Danger',
    inputSchema: objectSchema({ value: stringField() }),
    async call() {
      called = true;
      return { data: 'ran' };
    },
    mapResult(data, toolUseId) {
      return { toolUseId, content: data };
    },
  });
  const context = createRuntimeContext({
    hookConfig: {
      allowlist: ['deny-danger'],
      timeoutMs: 100,
      failurePolicy: 'fail-closed',
      hooks: [
        {
          id: 'deny-danger',
          event: 'preToolUse',
          run: () => ({ action: 'deny', message: 'blocked by hook' }),
        },
      ],
    },
    permissionAudit: [],
    hookAudit: [],
  });
  const runner = new ToolRunner(new ToolRegistry([tool]), context);

  const result = await runner.run({
    id: 'danger-1',
    name: 'Danger',
    input: { value: 'x' },
  });

  assert.equal(called, false);
  assert.equal(result.isError, true);
  assert.match(result.content, /blocked by hook/);
  assert.equal(context.permissionAudit?.at(-1)?.behavior, 'deny');
  assert.equal(context.permissionAudit?.at(-1)?.reason?.type, 'hook');
});

test('onApprovalRequired hooks can answer ask decisions', async () => {
  const requests: unknown[] = [];
  const context = createRuntimeContext({
    requestApproval: async (request) => {
      requests.push(request);
      return { behavior: 'deny', message: 'should not be called' };
    },
    hookConfig: {
      allowlist: ['approve-ask'],
      timeoutMs: 100,
      failurePolicy: 'fail-closed',
      hooks: [
        {
          id: 'approve-ask',
          event: 'onApprovalRequired',
          run: () => ({ action: 'allow', message: 'hook approved' }),
        },
      ],
    },
    hookAudit: [],
  });
  const asking = buildTool({
    name: 'NeedsAsk',
    inputSchema: objectSchema({ value: stringField() }),
    async checkPermissions() {
      return { behavior: 'ask', message: 'approve?' };
    },
    async call(input) {
      return { data: input.value };
    },
    mapResult(data, toolUseId) {
      return { toolUseId, content: data };
    },
  });
  const runner = new ToolRunner(new ToolRegistry([asking]), context);

  const result = await runner.run({
    id: 'ask-1',
    name: 'NeedsAsk',
    input: { value: 'go' },
  });

  assert.equal(result.isError, undefined);
  assert.equal(result.content, 'go');
  assert.equal(requests.length, 0);
  assert.equal(context.hookAudit?.at(-1)?.event, 'onApprovalRequired');
  assert.equal(context.hookAudit?.at(-1)?.action, 'allow');
});

test('failing hooks obey fail-open policy and emit a warning event', async () => {
  const events: SessionEvent[] = [];
  const session = new Session({
    model: {
      async *run() {
        yield {
          type: 'tool_use' as const,
          toolUseId: 'tool-1',
          name: 'ValueTool',
          input: { value: 'ok' },
        };
      },
    },
    tools: [valueTool],
    hooks: {
      allowlist: ['bad-hook'],
      timeoutMs: 100,
      failurePolicy: 'fail-open',
      hooks: [
        {
          id: 'bad-hook',
          event: 'preToolUse',
          run: () => {
            throw new Error('hook exploded');
          },
        },
      ],
    },
  });
  session.subscribe((event) => events.push(event));

  await session.submit('run tool');

  const failure = events.find((event) => event.type === 'hook_failure');
  assert.ok(failure);
  assert.match(failure.message, /hook exploded/);
  assert.equal(failure.policy, 'fail-open');
  assert.ok(events.some((event) => event.type === 'tool_result'));
});

test('beforeModelRun appendContext hooks augment the model input', async () => {
  let seenSystem = '';
  const session = new Session({
    model: {
      async *run(input) {
        seenSystem = input.system ?? '';
        yield { type: 'text' as const, text: 'done' };
      },
    },
    tools: [valueTool],
    systemPrompt: 'base system',
    hooks: {
      allowlist: ['context-hook'],
      timeoutMs: 100,
      failurePolicy: 'fail-closed',
      hooks: [
        {
          id: 'context-hook',
          event: 'beforeModelRun',
          run: () => ({ action: 'appendContext', context: 'extra context' }),
        },
      ],
    },
  });

  await session.submit('hello');

  assert.match(seenSystem, /base system/);
  assert.match(seenSystem, /extra context/);
});

test('loadHookConfig merges project and user config with allowlist filtering', () => {
  const project: HookConfig = {
    allowlist: ['project-hook'],
    timeoutMs: 50,
    failurePolicy: 'fail-closed',
    hooks: [
      {
        id: 'project-hook',
        event: 'sessionStart',
        run: () => ({ action: 'allow' }),
      },
    ],
  };
  const user: HookConfig = {
    allowlist: ['user-hook'],
    timeoutMs: 75,
    failurePolicy: 'fail-open',
    hooks: [
      {
        id: 'user-hook',
        event: 'sessionEnd',
        run: () => ({ action: 'allow' }),
      },
      {
        id: 'blocked-user-hook',
        event: 'sessionEnd',
        run: () => ({ action: 'allow' }),
      },
    ],
  };

  const merged = loadHookConfig({ project, user });

  assert.equal(merged.timeoutMs, 75);
  assert.equal(merged.failurePolicy, 'fail-open');
  assert.deepEqual(
    (merged.hooks ?? []).map((hook) => hook.id),
    ['project-hook', 'user-hook'],
  );
});
