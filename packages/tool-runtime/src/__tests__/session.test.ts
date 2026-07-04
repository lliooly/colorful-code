import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  Session,
  buildTool,
  createBuiltinTools,
  createScriptedModelClient,
  objectSchema,
  type ModelClient,
  type ModelTurnInput,
  type ScriptedRound,
  type PermissionContext,
  type SessionEvent,
  type McpManager,
} from '../index.js';

const countChars = (text: string) => text.length;

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'colorful-session-runtime-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// Spins the microtask/macrotask queue so parked promises (approvals) settle and
// emitted events flush before assertions run.
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Waits until `predicate` holds, pumping the event loop between checks. Bounded
// so a stuck run fails the test instead of hanging.
async function waitFor(
  predicate: () => boolean,
  label: string,
  attempts = 50,
): Promise<void> {
  for (let i = 0; i < attempts; i += 1) {
    if (predicate()) {
      return;
    }
    await flush();
  }
  assert.fail('timed out waiting for: ' + label);
}

test('a turn streams text, runs a read-only tool, then a final completion completes in order', async () => {
  // Round 0: the model answers with text and requests a tool, ending the
  // completion. Round 1: the model sees the tool result and gives a final
  // text answer with no further tools, which ends the turn.
  const rounds: ScriptedRound[] = [
    [
      { type: 'text', text: 'Listing tasks.' },
      { type: 'tool_use', toolUseId: 'call-1', name: 'TaskList', input: {} },
    ],
    [{ type: 'text', text: 'Here are your tasks.' }],
  ];
  const session = new Session({
    model: createScriptedModelClient(rounds),
    tools: createBuiltinTools(),
  });

  const events: SessionEvent[] = [];
  session.subscribe((event) => events.push(event));

  await session.submit('list my tasks');

  const order = events.map((event) => event.type);
  assert.deepEqual(order, [
    'run_status', // running
    'message_delta', // round 0 text
    'message', // round 0 assistant entry (pushed before tools run)
    'tool_call',
    'permission_decision',
    'tool_result',
    'message_delta', // round 1 text
    'message', // round 1 assistant entry
    'run_status', // completed
  ]);
  assert.equal((events[0] as { status: string }).status, 'running');
  assert.equal((events.at(-1) as { status: string }).status, 'completed');

  const toolResult = events.find((event) => event.type === 'tool_result');
  assert.ok(toolResult);
  assert.equal((toolResult as { isError?: boolean }).isError, undefined);

  // History reads: user, assistant(+toolCalls), tool(results), assistant(final).
  const snapshot = session.snapshot();
  assert.deepEqual(
    snapshot.history.map((entry) => entry.role),
    ['user', 'assistant', 'tool', 'assistant'],
  );
  assert.equal(snapshot.history[1]?.toolCalls?.[0]?.name, 'TaskList');
  assert.equal(snapshot.history[2]?.toolResults?.[0]?.toolUseId, 'call-1');
  assert.equal(snapshot.history[3]?.content, 'Here are your tasks.');
});

test('a turn emits visible thinking deltas from the model stream', async () => {
  const session = new Session({
    model: createScriptedModelClient([
      [
        { type: 'thinking', text: 'Checking context.' },
        { type: 'text', text: 'Answer.' },
      ],
    ]),
    tools: [],
  });

  const events: SessionEvent[] = [];
  session.subscribe((event) => events.push(event));

  await session.submit('think visibly');

  assert.deepEqual(
    events.map((event) => event.type),
    ['run_status', 'thinking_delta', 'message_delta', 'message', 'run_status'],
  );
  const thinking = events.find(
    (event): event is Extract<SessionEvent, { type: 'thinking_delta' }> =>
      event.type === 'thinking_delta',
  );
  assert.equal(thinking?.text, 'Checking context.');
});

test('manual context compaction emits visible progress and result events', async () => {
  const model: ModelClient = {
    run(input) {
      const text = input.system === 'compact prompt' ? 'SUMMARY' : 'ok';
      return (async function* () {
        yield { type: 'text', text };
        yield { type: 'end' };
      })();
    },
  };
  const session = new Session({
    model,
    tools: [],
    compaction: {
      contextWindow: 10_000,
      threshold: 10,
      keepRecentTokens: 10,
      prompt: 'compact prompt',
      estimateTokens: countChars,
    },
  });
  const events: SessionEvent[] = [];
  session.subscribe((event) => events.push(event));

  await session.submit('A'.repeat(5000));
  await session.submit('second');
  session.send({ type: 'compact' });

  await waitFor(
    () => events.some((event) => event.type === 'context_compacted'),
    'context_compacted',
  );

  const started = events.find(
    (event) => event.type === 'context_compaction_started',
  );
  const compacted = events.find(
    (event): event is Extract<SessionEvent, { type: 'context_compacted' }> =>
      event.type === 'context_compacted',
  );
  assert.ok(started);
  assert.ok(compacted);
  assert.equal(compacted.entriesSummarized, 2);
  assert.ok(compacted.tokensAfter < compacted.tokensBefore);
});

test('manual context compaction waits for an active run instead of requiring another message', async () => {
  let ordinaryRuns = 0;
  let releaseThirdRun: (() => void) | undefined;
  let markThirdRunStarted: (() => void) | undefined;
  const thirdRunStarted = new Promise<void>((resolve) => {
    markThirdRunStarted = resolve;
  });
  const model: ModelClient = {
    run(input) {
      if (input.system === 'compact prompt') {
        return (async function* () {
          yield { type: 'text', text: 'SUMMARY' };
          yield { type: 'end' };
        })();
      }
      ordinaryRuns += 1;
      const runNumber = ordinaryRuns;
      return (async function* () {
        if (runNumber === 3) {
          markThirdRunStarted?.();
          await new Promise<void>((resolve) => {
            releaseThirdRun = resolve;
          });
        }
        yield { type: 'text', text: 'ok' };
        yield { type: 'end' };
      })();
    },
  };
  const session = new Session({
    model,
    tools: [],
    compaction: {
      contextWindow: 10_000,
      threshold: 10,
      keepRecentTokens: 10,
      prompt: 'compact prompt',
      estimateTokens: countChars,
    },
  });
  const events: SessionEvent[] = [];
  session.subscribe((event) => events.push(event));

  await session.submit('A'.repeat(5000));
  await session.submit('second');
  const third = session.submit('third');
  await thirdRunStarted;
  session.send({ type: 'compact' });
  await flush();

  assert.ok(
    !events.some(
      (event) =>
        event.type === 'context_compaction_skipped' &&
        event.reason.includes('currently active'),
    ),
  );

  releaseThirdRun?.();
  await third;
  await waitFor(
    () => events.some((event) => event.type === 'context_compacted'),
    'queued context_compacted',
  );
});

test('the loop issues multiple model.run calls when a tool use occurs', async () => {
  // A spy model wrapping the scripted client so we can count completions. A
  // turn that requests a tool must drive at least two completions (one to
  // request the tool, one to observe the result and finish).
  const inner = createScriptedModelClient([
    [{ type: 'tool_use', toolUseId: 'call-1', name: 'TaskList', input: {} }],
    [{ type: 'text', text: 'All done.' }],
  ]);
  let runCalls = 0;
  const session = new Session({
    model: {
      run(input) {
        runCalls += 1;
        return inner.run(input);
      },
    },
    tools: createBuiltinTools(),
  });

  await session.submit('list tasks');

  assert.ok(
    runCalls >= 2,
    'expected the multi-round loop to call model.run at least twice, got ' +
      String(runCalls),
  );
});

test('Session injects the MCP manager into runtime context', async () => {
  let closed = false;
  const manager: McpManager = {
    async connectAll() {
      return [];
    },
    async callTool() {
      return 'ok';
    },
    async listResources() {
      return [];
    },
    async readResource() {
      return { contents: [] };
    },
    async close() {
      closed = true;
    },
  };
  const session = new Session({
    model: createScriptedModelClient([[{ type: 'text', text: 'done' }]]),
    tools: createBuiltinTools(),
    mcpManager: manager,
  });

  assert.equal(session.context.mcpManager, manager);
  await session.context.mcpManager?.close?.();
  assert.equal(closed, true);
});

test('Agent runs a child session synchronously and returns its final output', async () => {
  const scripted = createScriptedModelClient([
    [
      {
        type: 'tool_use',
        toolUseId: 'agent-call',
        name: 'Agent',
        input: {
          description: 'Inspect the project',
          prompt: 'Find the important detail',
          subagent_type: 'research',
        },
      },
    ],
    [{ type: 'text', text: 'child found the important detail.' }],
    [{ type: 'text', text: 'parent saw the child result.' }],
  ]);
  const seen: ModelTurnInput[] = [];
  const session = new Session({
    model: {
      run(input) {
        seen.push(input);
        return scripted.run(input);
      },
    },
    tools: createBuiltinTools(),
    systemPrompt: 'Shared project instructions.',
  });

  const events: SessionEvent[] = [];
  session.subscribe((event) => events.push(event));

  await session.submit('delegate this');

  const toolResult = events.find(
    (event): event is Extract<SessionEvent, { type: 'tool_result' }> =>
      event.type === 'tool_result' && event.toolUseId === 'agent-call',
  );
  assert.ok(toolResult);
  assert.match(
    toolResult.content,
    /child found the important detail\./,
    'Agent tool result includes the child final answer',
  );

  assert.equal(seen.length, 3, 'parent, child, then resumed parent');
  assert.equal(seen[1]?.history[0]?.role, 'user');
  assert.equal(seen[1]?.history[0]?.content, 'Find the important detail');
  assert.equal(seen[1]?.system, 'Shared project instructions.');
  assert.match(
    seen[2]?.history[2]?.toolResults?.[0]?.content ?? '',
    /child found the important detail\./,
    'parent resumes with the child output as the Agent tool result',
  );

  const tasks = session.context.tasks;
  const task = tasks?.get('agent-1');
  assert.equal(task?.status, 'completed');
  assert.match(task?.output ?? '', /child found the important detail\./);
  assert.equal((events.at(-1) as { status: string }).status, 'completed');
});

test('Agent child approval requests bubble through the parent session', async () => {
  const approvalTool = buildTool({
    name: 'NeedsApproval',
    inputSchema: objectSchema({}),
    checkPermissions() {
      return { behavior: 'ask', message: 'Approve child tool?' };
    },
    async call() {
      return { data: 'approved child tool' };
    },
    mapResult(data, toolUseId) {
      return { toolUseId, content: data };
    },
  });
  const scripted = createScriptedModelClient([
    [
      {
        type: 'tool_use',
        toolUseId: 'agent-call',
        name: 'Agent',
        input: {
          description: 'Run approval child',
          prompt: 'Use the gated tool',
        },
      },
    ],
    [
      {
        type: 'tool_use',
        toolUseId: 'child-tool',
        name: 'NeedsApproval',
        input: {},
      },
    ],
    [{ type: 'text', text: 'child completed after approval.' }],
    [{ type: 'text', text: 'parent finished.' }],
  ]);
  const session = new Session({
    model: scripted,
    tools: [...createBuiltinTools(), approvalTool],
  });
  const events: SessionEvent[] = [];
  session.subscribe((event) => events.push(event));

  const done = session.submit('delegate gated work');
  await waitFor(
    () => events.some((event) => event.type === 'approval_required'),
    'child approval_required',
  );

  const approval = events.find(
    (event): event is Extract<SessionEvent, { type: 'approval_required' }> =>
      event.type === 'approval_required',
  );
  assert.ok(approval);
  assert.equal(approval.name, 'NeedsApproval');
  assert.equal(approval.toolUseId, 'child-tool');

  session.send({
    type: 'approval_response',
    requestId: approval.requestId,
    decision: { behavior: 'allow' },
  });
  await done;

  const agentResult = events.find(
    (event): event is Extract<SessionEvent, { type: 'tool_result' }> =>
      event.type === 'tool_result' && event.toolUseId === 'agent-call',
  );
  assert.ok(agentResult);
  assert.match(agentResult.content, /child completed after approval\./);
  assert.equal((events.at(-1) as { status: string }).status, 'completed');
});

test('cancel while Agent child is waiting for approval cancels the parent run', async () => {
  const approvalTool = buildTool({
    name: 'NeedsApproval',
    inputSchema: objectSchema({}),
    checkPermissions() {
      return { behavior: 'ask', message: 'Approve child tool?' };
    },
    async call() {
      return { data: 'approved child tool' };
    },
    mapResult(data, toolUseId) {
      return { toolUseId, content: data };
    },
  });
  const session = new Session({
    model: createScriptedModelClient([
      [
        {
          type: 'tool_use',
          toolUseId: 'agent-call',
          name: 'Agent',
          input: {
            description: 'Run cancellable child',
            prompt: 'Use the gated tool',
          },
        },
      ],
      [
        {
          type: 'tool_use',
          toolUseId: 'child-tool',
          name: 'NeedsApproval',
          input: {},
        },
      ],
    ]),
    tools: [...createBuiltinTools(), approvalTool],
  });
  const events: SessionEvent[] = [];
  session.subscribe((event) => events.push(event));

  const done = session.submit('delegate cancellable work');
  await waitFor(
    () => events.some((event) => event.type === 'approval_required'),
    'child approval_required',
  );

  session.send({ type: 'cancel' });
  await done;

  const statuses = events
    .filter((event) => event.type === 'run_status')
    .map((event) => event.status);
  assert.ok(statuses.includes('cancelled'));
  assert.ok(!statuses.includes('completed'));
  assert.equal(session.context.tasks?.get('agent-1')?.status, 'error');
});

test('a turn runs neighboring read-only tool uses concurrently', async () => {
  const readTool = buildTool({
    name: 'SlowRead',
    inputSchema: objectSchema({}),
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    async call() {
      await delay(70);
      return { data: 'read' };
    },
    mapResult(data, toolUseId) {
      return { toolUseId, content: data };
    },
  });
  const session = new Session({
    model: createScriptedModelClient([
      [
        { type: 'tool_use', toolUseId: 'read-1', name: 'SlowRead', input: {} },
        { type: 'tool_use', toolUseId: 'read-2', name: 'SlowRead', input: {} },
      ],
      [{ type: 'text', text: 'Done.' }],
    ]),
    tools: [readTool],
  });

  const events: SessionEvent[] = [];
  session.subscribe((event) => events.push(event));

  const started = Date.now();
  await session.submit('read twice');
  const elapsed = Date.now() - started;

  assert.ok(elapsed < 125, 'expected read-only tool uses to overlap');
  assert.deepEqual(
    events
      .filter((event) => event.type === 'tool_result')
      .map((event) => (event as { toolUseId: string }).toolUseId),
    ['read-1', 'read-2'],
  );
});

test('an ask parks on approval_required and completes after an allow response', async () => {
  // `default` mode + a destructive built-in (the model calls Write) routes to
  // `ask`, which the session surfaces as a correlated approval prompt. A second
  // round with no tools lets the turn complete after the tool result feeds back.
  const rounds: ScriptedRound[] = [
    [
      {
        type: 'tool_use',
        toolUseId: 'call-1',
        name: 'Write',
        input: { path: '/tmp/colorful-session-ignored.txt', content: 'x' },
      },
    ],
    [{ type: 'text', text: 'Wrote the file.' }],
  ];
  const permissionContext: PermissionContext = {
    mode: 'default',
    workspaceRoots: [],
    rules: [{ source: 'session', behavior: 'ask', toolName: 'Write' }],
  };
  const session = new Session({
    model: createScriptedModelClient(rounds),
    tools: createBuiltinTools(),
    permissionContext,
  });

  const events: SessionEvent[] = [];
  session.subscribe((event) => events.push(event));

  const done = session.submit('write a file');

  await waitFor(
    () => events.some((event) => event.type === 'approval_required'),
    'approval_required',
  );
  const approval = events.find((event) => event.type === 'approval_required');
  assert.ok(approval);
  const requestId = (approval as { requestId: string }).requestId;
  assert.equal((approval as { name: string }).name, 'Write');

  // Not yet completed while parked.
  assert.ok(
    !events.some(
      (event) =>
        event.type === 'run_status' &&
        (event as { status: string }).status === 'completed',
    ),
  );

  session.send({
    type: 'approval_response',
    requestId,
    decision: { behavior: 'allow' },
  });
  await done;

  const decision = events.find((event) => event.type === 'permission_decision');
  assert.ok(decision);
  assert.equal(
    (decision as { entry: { behavior: string } }).entry.behavior,
    'allow',
  );
  assert.equal((events.at(-1) as { status: string }).status, 'completed');
});

test('cancel mid-run yields run_status:cancelled and auto-denies a pending approval', async () => {
  const rounds: ScriptedRound[] = [
    [
      {
        type: 'tool_use',
        toolUseId: 'call-1',
        name: 'Write',
        input: { path: '/tmp/colorful-session-cancel.txt', content: 'x' },
      },
    ],
  ];
  const permissionContext: PermissionContext = {
    mode: 'default',
    workspaceRoots: [],
    rules: [{ source: 'session', behavior: 'ask', toolName: 'Write' }],
  };
  const session = new Session({
    model: createScriptedModelClient(rounds),
    tools: createBuiltinTools(),
    permissionContext,
  });

  const events: SessionEvent[] = [];
  session.subscribe((event) => events.push(event));

  const done = session.submit('write a file');

  await waitFor(
    () => events.some((event) => event.type === 'approval_required'),
    'approval_required',
  );

  session.send({ type: 'cancel' });
  await done;

  // The denied (auto-deny) tool result surfaces as an error, and the run ends
  // cancelled rather than completed.
  const statuses = events
    .filter((event) => event.type === 'run_status')
    .map((event) => (event as { status: string }).status);
  assert.ok(statuses.includes('cancelled'));
  assert.ok(!statuses.includes('completed'));
});

test('a proposed edit emits lifecycle events and only writes after approval', async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, 'note.txt');
    await writeFile(file, 'hello world\n', 'utf8');
    const rounds: ScriptedRound[] = [
      [
        {
          type: 'tool_use',
          toolUseId: 'read-1',
          name: 'Read',
          input: { path: file },
        },
        {
          type: 'tool_use',
          toolUseId: 'propose-1',
          name: 'ProposeEdit',
          input: { path: file, oldText: 'hello', newText: 'hi' },
        },
      ],
      [{ type: 'text', text: 'Patch proposed.' }],
    ];
    const session = new Session({
      model: createScriptedModelClient(rounds),
      tools: createBuiltinTools(),
    });
    const events: SessionEvent[] = [];
    session.subscribe((event) => events.push(event));

    await session.submit('edit the file');
    await waitFor(
      () => events.some((event) => event.type === 'edit_proposed'),
      'edit_proposed',
    );

    assert.equal(await readFile(file, 'utf8'), 'hello world\n');
    const proposed = events.find(
      (event): event is Extract<SessionEvent, { type: 'edit_proposed' }> =>
        event.type === 'edit_proposed',
    );
    assert.ok(proposed);
    session.send({
      type: 'edit_decision',
      proposalId: proposed.proposalId,
      decision: 'approve',
    });
    await waitFor(
      () => events.some((event) => event.type === 'edit_applied'),
      'edit_applied',
    );

    assert.ok(events.some((event) => event.type === 'edit_approved'));
    assert.ok(events.some((event) => event.type === 'edit_applied'));
    assert.equal(await readFile(file, 'utf8'), 'hi world\n');
  });
});

test('rejecting a proposed edit emits edit_rejected and leaves the file unchanged', async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, 'note.txt');
    await writeFile(file, 'hello world\n', 'utf8');
    const session = new Session({
      model: createScriptedModelClient([
        [
          {
            type: 'tool_use',
            toolUseId: 'read-1',
            name: 'Read',
            input: { path: file },
          },
          {
            type: 'tool_use',
            toolUseId: 'propose-1',
            name: 'ProposeEdit',
            input: { path: file, oldText: 'hello', newText: 'hi' },
          },
        ],
        [{ type: 'text', text: 'Patch rejected.' }],
      ]),
      tools: createBuiltinTools(),
    });
    const events: SessionEvent[] = [];
    session.subscribe((event) => events.push(event));

    await session.submit('edit the file');
    await waitFor(
      () => events.some((event) => event.type === 'edit_proposed'),
      'edit_proposed',
    );
    const proposed = events.find(
      (event): event is Extract<SessionEvent, { type: 'edit_proposed' }> =>
        event.type === 'edit_proposed',
    );
    assert.ok(proposed);
    session.send({
      type: 'edit_decision',
      proposalId: proposed.proposalId,
      decision: 'reject',
    });
    await waitFor(
      () => events.some((event) => event.type === 'edit_rejected'),
      'edit_rejected',
    );

    assert.ok(events.some((event) => event.type === 'edit_rejected'));
    assert.equal(await readFile(file, 'utf8'), 'hello world\n');
  });
});

test('snapshot then restore preserves history and permission mode', async () => {
  const rounds: ScriptedRound[] = [[{ type: 'text', text: 'Hello there.' }]];
  const session = new Session({
    model: createScriptedModelClient(rounds),
    tools: createBuiltinTools(),
    permissionContext: { mode: 'plan', workspaceRoots: ['/work'], rules: [] },
  });

  await session.submit('say hello');

  const snapshot = session.snapshot();
  assert.equal(snapshot.permissionMode, 'plan');
  assert.equal(snapshot.history.length, 2); // user + assistant
  assert.equal(snapshot.history[0]?.role, 'user');
  assert.equal(snapshot.history[1]?.content, 'Hello there.');

  const restored = Session.restore(snapshot, {
    model: createScriptedModelClient([]),
    tools: createBuiltinTools(),
  });

  assert.equal(restored.id, session.id);
  assert.equal(restored.permissionContext.mode, 'plan');
  const restoredSnapshot = restored.snapshot();
  assert.deepEqual(restoredSnapshot.history, snapshot.history);
  assert.equal(restoredSnapshot.permissionMode, 'plan');
});

test('a session forwards its systemPrompt to the model on every turn', async () => {
  // A capturing model records the ModelTurnInput it is handed, then ends the
  // completion immediately. This proves the session threads `systemPrompt` all
  // the way to `model.run`, rather than the adapter having to guess a system
  // prompt from the conversation history.
  const seen: ModelTurnInput[] = [];
  const capturingModel: ModelClient = {
    run(input: ModelTurnInput) {
      seen.push(input);
      return (async function* () {
        yield { type: 'end' as const };
      })();
    },
  };

  const session = new Session({
    model: capturingModel,
    tools: createBuiltinTools(),
    systemPrompt: 'You are Colorful Code.',
  });

  await session.submit('hello');

  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.system, 'You are Colorful Code.');
});
