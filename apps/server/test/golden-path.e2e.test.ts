import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { Module, RequestMethod } from '@nestjs/common';
import {
  METHOD_METADATA,
  PATH_METADATA,
  SSE_METADATA,
} from '@nestjs/common/constants';
import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import {
  createScriptedModelClient,
  type ModelClient,
  type SessionEvent,
} from '@colorful-code/tool-runtime';
import { SessionsController } from '../src/sessions/sessions.controller';
import { SessionsService } from '../src/sessions/sessions.service';
import {
  MODEL_CLIENT_FACTORY,
  type ModelClientFactory,
} from '../src/sessions/model-factory';
import { SessionStore } from '../src/persistence/session-store';

// ---------------------------------------------------------------------------
// Test harness: boot the real Nest app on the Fastify platform in-process and
// drive REST endpoints with Fastify inject. The SSE route mapping is asserted
// from Nest metadata, while event payloads are consumed from the controller's
// @Sse() Observable to keep the long-lived stream deterministic under Bun. We
// deliberately avoid
// @nestjs/testing and supertest to keep the repo's no-extra-deps posture. The
// MODEL_CLIENT_FACTORY provider is overridden here with a scripted client, so
// the HTTP API itself never carries test scripts (the request bodies stay
// production-shaped).
// ---------------------------------------------------------------------------

// Round 0: some text + a tool_use for the read-only built-in `TaskList`.
// Round 1: a final text answer (no tool use) -> the turn completes.
// We seed the session's PermissionContext with a `session`-source `ask` rule on
// `TaskList`, which short-circuits the policy to `ask` (step 3 of
// evaluatePermission) even though TaskList is read-only. TaskList is fully
// deterministic and succeeds when allowed (returns the empty task list).
const scriptedFactory: ModelClientFactory = (): ModelClient =>
  createScriptedModelClient([
    [
      { type: 'text', text: 'Let me list the current tasks.' },
      { type: 'tool_use', toolUseId: 'call-1', name: 'TaskList', input: {} },
    ],
    [{ type: 'text', text: 'There are no tasks yet.' }],
  ]);

// An in-memory persistence store so the wired SessionsService can satisfy its
// SessionStore dependency without touching the filesystem. The golden path does
// not assert persistence (covered by session-store.test.ts); this just keeps the
// transport contract green.
@Module({
  controllers: [SessionsController],
  providers: [
    SessionsService,
    { provide: MODEL_CLIENT_FACTORY, useValue: scriptedFactory },
    { provide: SessionStore, useValue: SessionStore.openAt(':memory:') },
  ],
})
class TestAppModule {}

let app: NestFastifyApplication | undefined;
let editTestFilePath = '';

const editFactory: ModelClientFactory = (): ModelClient =>
  createScriptedModelClient([
    [
      {
        type: 'tool_use',
        toolUseId: 'read-1',
        name: 'Read',
        input: { path: editTestFilePath },
      },
      {
        type: 'tool_use',
        toolUseId: 'propose-1',
        name: 'ProposeEdit',
        input: { path: editTestFilePath, oldText: 'hello', newText: 'hi' },
      },
    ],
    [{ type: 'text', text: 'Patch proposed.' }],
  ]);

@Module({
  controllers: [SessionsController],
  providers: [
    SessionsService,
    { provide: MODEL_CLIENT_FACTORY, useValue: editFactory },
    { provide: SessionStore, useValue: SessionStore.openAt(':memory:') },
  ],
})
class EditFlowTestAppModule {}

async function boot(): Promise<void> {
  app = await NestFactory.create<NestFastifyApplication>(
    TestAppModule,
    new FastifyAdapter(),
    { logger: false },
  );
  await app.init();
}

async function bootEditFlow(): Promise<void> {
  app = await NestFactory.create<NestFastifyApplication>(
    EditFlowTestAppModule,
    new FastifyAdapter(),
    { logger: false },
  );
  await app.init();
}

afterEach(async () => {
  if (app) {
    await app.close();
    app = undefined;
  }
});

function jsonBody<T>(response: { payload: string }): T {
  return JSON.parse(response.payload) as T;
}

function assertSseRouteMetadata(controller: SessionsController): void {
  const handler = controller.events;
  assert.equal(
    Reflect.getMetadata(SSE_METADATA, handler),
    true,
    'events() is decorated as an SSE endpoint',
  );
  assert.equal(
    Reflect.getMetadata(PATH_METADATA, handler),
    ':id/events',
    'events() is mapped to /sessions/:id/events',
  );
  assert.equal(
    Reflect.getMetadata(METHOD_METADATA, handler),
    RequestMethod.GET,
    'events() is mapped to HTTP GET',
  );
}

test('golden path: approval round-trip over REST + SSE', async () => {
  await boot();
  assert.ok(app, 'app is initialized');
  const fastify = app.getHttpAdapter().getInstance();
  const controller = app.get(SessionsController);

  // 1) Create a session whose PermissionContext makes TaskList trigger `ask`.
  const createRes = await fastify.inject({
    method: 'POST',
    url: '/sessions',
    payload: {
      permissionMode: 'default',
      rules: [{ source: 'session', behavior: 'ask', toolName: 'TaskList' }],
    },
  });
  assert.equal(createRes.statusCode, 201, 'POST /sessions returns 201');
  const { id } = jsonBody<{ id: string }>(createRes);
  assert.ok(id, 'create returns an id');

  // 2) Assert the controller still exposes the real GET SSE route without
  //    relying on sandboxed socket permissions.
  assertSseRouteMetadata(controller);

  // 3) Subscribe to the controller's SSE Observable BEFORE submitting. The
  //    subscription is consumed with a cursor so assertions prove stream order.
  const seen: SessionEvent[] = [];
  const subscription = controller.events(id).subscribe((message) => {
    seen.push(message.data as SessionEvent);
  });

  // Collects events in stream order until `predicate` is satisfied, returning
  // the matched event.
  let cursor = 0;
  async function until(
    predicate: (event: SessionEvent) => boolean,
  ): Promise<SessionEvent> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      while (cursor < seen.length) {
        const event = seen[cursor];
        cursor += 1;
        if (predicate(event)) {
          return event;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.fail('SSE stream did not emit the expected event before timeout');
  }

  try {
    // 4) Submit a user message (fire-and-forget; progress flows over SSE).
    const msgRes = await fastify.inject({
      method: 'POST',
      url: `/sessions/${id}/messages`,
      payload: { text: 'List my tasks.' },
    });
    assert.equal(msgRes.statusCode, 202, 'POST /messages acks with 202');

    // 5) Assert the ordered prefix: running -> tool_call -> approval_required.
    await until((e) => e.type === 'run_status' && e.status === 'running');
    const toolCall = await until((e) => e.type === 'tool_call');
    assert.equal(
      toolCall.type === 'tool_call' && toolCall.name,
      'TaskList',
      'tool_call is for TaskList',
    );
    const approval = await until((e) => e.type === 'approval_required');
    assert.equal(approval.type, 'approval_required');
    const requestId =
      approval.type === 'approval_required' ? approval.requestId : '';
    assert.ok(requestId, 'approval_required carries a requestId');

    // 6) Approve via POST /control with the captured requestId.
    const controlRes = await fastify.inject({
      method: 'POST',
      url: `/sessions/${id}/control`,
      payload: {
        type: 'approval_response',
        requestId,
        decision: { behavior: 'allow' },
      },
    });
    assert.equal(controlRes.statusCode, 202, 'POST /control acks with 202');

    // 7) Assert the tool result (not an error) and final completion.
    const toolResult = await until((e) => e.type === 'tool_result');
    assert.equal(
      toolResult.type === 'tool_result' && toolResult.isError,
      undefined,
      'tool_result is not an error',
    );
    await until((e) => e.type === 'run_status' && e.status === 'completed');

    // 8) Assert an allow permission_decision was emitted somewhere in the run.
    const allowDecision = seen.find(
      (e) => e.type === 'permission_decision' && e.entry.behavior === 'allow',
    );
    assert.ok(
      allowDecision,
      'a permission_decision (allow) was emitted for the approved tool',
    );
  } finally {
    subscription.unsubscribe();
    await fastify
      .inject({ method: 'DELETE', url: `/sessions/${id}` })
      .catch(() => undefined);
  }
});

test('diff edit lifecycle streams over SSE and applies after REST approval', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'colorful-code-edit-sse-'));
  editTestFilePath = join(dir, 'note.txt');
  await writeFile(editTestFilePath, 'hello world\n', 'utf8');

  try {
    await bootEditFlow();
    assert.ok(app, 'app is initialized');
    const fastify = app.getHttpAdapter().getInstance();
    const controller = app.get(SessionsController);

    const createRes = await fastify.inject({
      method: 'POST',
      url: '/sessions',
      payload: { permissionMode: 'default' },
    });
    assert.equal(createRes.statusCode, 201, 'POST /sessions returns 201');
    const { id } = jsonBody<{ id: string }>(createRes);
    const seen: SessionEvent[] = [];
    const subscription = controller.events(id).subscribe((message) => {
      seen.push(message.data as SessionEvent);
    });

    let cursor = 0;
    async function until(
      predicate: (event: SessionEvent) => boolean,
    ): Promise<SessionEvent> {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        while (cursor < seen.length) {
          const event = seen[cursor];
          cursor += 1;
          if (predicate(event)) {
            return event;
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.fail('SSE stream did not emit the expected edit event in time');
    }

    try {
      const msgRes = await fastify.inject({
        method: 'POST',
        url: `/sessions/${id}/messages`,
        payload: { text: 'Propose an edit.' },
      });
      assert.equal(msgRes.statusCode, 202, 'POST /messages acks with 202');

      const proposed = await until((event) => event.type === 'edit_proposed');
      assert.equal(await readFile(editTestFilePath, 'utf8'), 'hello world\n');
      assert.equal(proposed.type, 'edit_proposed');
      const proposalId =
        proposed.type === 'edit_proposed' ? proposed.proposalId : '';

      const controlRes = await fastify.inject({
        method: 'POST',
        url: `/sessions/${id}/control`,
        payload: {
          type: 'edit_decision',
          proposalId,
          decision: 'approve',
        },
      });
      assert.equal(controlRes.statusCode, 202, 'POST /control acks with 202');

      await until((event) => event.type === 'edit_approved');
      await until((event) => event.type === 'edit_applied');
      assert.equal(await readFile(editTestFilePath, 'utf8'), 'hi world\n');
    } finally {
      subscription.unsubscribe();
      await fastify
        .inject({ method: 'DELETE', url: `/sessions/${id}` })
        .catch(() => undefined);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
    editTestFilePath = '';
  }
});

test('watchWorkspace streams external file changes over SSE', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'colorful-code-watch-sse-'));

  try {
    await boot();
    assert.ok(app, 'app is initialized');
    const fastify = app.getHttpAdapter().getInstance();
    const controller = app.get(SessionsController);

    const createRes = await fastify.inject({
      method: 'POST',
      url: '/sessions',
      payload: { cwd: dir, workspaceRoots: [dir], watchWorkspace: true },
    });
    assert.equal(createRes.statusCode, 201, 'POST /sessions returns 201');
    const { id } = jsonBody<{ id: string }>(createRes);
    const seen: SessionEvent[] = [];
    const subscription = controller.events(id).subscribe((message) => {
      seen.push(message.data as SessionEvent);
    });

    async function until(
      predicate: (event: SessionEvent) => boolean,
    ): Promise<SessionEvent> {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        const found = seen.find(predicate);
        if (found) {
          return found;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.fail('SSE stream did not emit the expected file event in time');
    }

    try {
      const file = join(dir, 'outside.txt');
      await writeFile(file, 'external', 'utf8');
      const created = await until(
        (event) => event.type === 'file_created' && event.path === file,
      );
      assert.equal(created.type, 'file_created');
    } finally {
      subscription.unsubscribe();
      await fastify
        .inject({ method: 'DELETE', url: `/sessions/${id}` })
        .catch(() => undefined);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('rejects malformed create and control bodies with 400', async () => {
  await boot();
  assert.ok(app, 'app is initialized');
  const fastify = app.getHttpAdapter().getInstance();

  const postJson = (
    path: string,
    body: unknown,
  ): Promise<{ statusCode: number; payload: string }> =>
    fastify.inject({
      method: 'POST',
      url: path,
      payload: body,
    });

  // A non-string workspace root would otherwise throw during path resolution
  // in acceptEdits mode rather than fail cleanly.
  const badRoots = await postJson('/sessions', {
    permissionMode: 'acceptEdits',
    workspaceRoots: [null],
  });
  assert.equal(badRoots.statusCode, 400, 'non-string workspaceRoots -> 400');

  // A rule with an unknown behavior must not enter permission evaluation.
  const badRule = await postJson('/sessions', {
    rules: [{ source: 'session', behavior: 'maybe', toolName: 'TaskList' }],
  });
  assert.equal(badRule.statusCode, 400, 'invalid rule.behavior -> 400');

  // A misspelled mode must 400 rather than silently fall back to `default`
  // (which would be less restrictive than the client asked for).
  const badMode = await postJson('/sessions', { permissionMode: 'readOnlyy' });
  assert.equal(badMode.statusCode, 400, 'misspelled permissionMode -> 400');

  const badWatch = await postJson('/sessions', { watchWorkspace: 'yes' });
  assert.equal(badWatch.statusCode, 400, 'non-boolean watchWorkspace -> 400');

  // A valid session for the control-body checks.
  const okRes = await postJson('/sessions', {});
  assert.equal(okRes.statusCode, 201);
  const { id } = jsonBody<{ id: string }>(okRes);

  try {
    // A non-object updatedInput would otherwise reach tool.call unvalidated,
    // since the runner uses it as the tool input without re-parsing.
    const badApproval = await postJson(`/sessions/${id}/control`, {
      type: 'approval_response',
      requestId: 'whatever',
      decision: { behavior: 'allow', updatedInput: 'not-an-object' },
    });
    assert.equal(badApproval.statusCode, 400, 'string updatedInput -> 400');

    const unknownType = await postJson(`/sessions/${id}/control`, {
      type: 'nonsense',
    });
    assert.equal(unknownType.statusCode, 400, 'unknown control type -> 400');
  } finally {
    await fastify
      .inject({ method: 'DELETE', url: `/sessions/${id}` })
      .catch(() => undefined);
  }
});
