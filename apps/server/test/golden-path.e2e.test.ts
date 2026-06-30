import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { after, test } from 'node:test';
import { AddressInfo } from 'node:net';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  NestFastifyApplication
} from '@nestjs/platform-fastify';
import {
  createScriptedModelClient,
  type ModelClient,
  type SessionEvent
} from '@colorful-code/tool-runtime';
import { SessionsController } from '../src/sessions/sessions.controller';
import { SessionsService } from '../src/sessions/sessions.service';
import {
  MODEL_CLIENT_FACTORY,
  type ModelClientFactory
} from '../src/sessions/model-factory';
import { SessionStore } from '../src/persistence/session-store';

// ---------------------------------------------------------------------------
// Test harness: boot the real Nest app on the Fastify platform on an ephemeral
// port and drive it over HTTP with Node 22's global fetch (JSON endpoints + the
// SSE stream). We deliberately avoid @nestjs/testing and supertest to keep the
// repo's no-extra-deps posture. The MODEL_CLIENT_FACTORY provider is overridden
// here with a scripted client, so the HTTP API itself never carries test
// scripts (the request bodies stay production-shaped).
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
      { type: 'tool_use', toolUseId: 'call-1', name: 'TaskList', input: {} }
    ],
    [{ type: 'text', text: 'There are no tasks yet.' }]
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
    { provide: SessionStore, useValue: SessionStore.openAt(':memory:') }
  ]
})
class TestAppModule {}

let app: NestFastifyApplication | undefined;
let baseUrl = '';

async function boot(): Promise<string> {
  if (app) {
    return baseUrl;
  }
  app = await NestFactory.create<NestFastifyApplication>(
    TestAppModule,
    new FastifyAdapter(),
    { logger: false }
  );
  // Listen on an ephemeral port (0) bound to loopback.
  await app.listen(0, '127.0.0.1');
  const server = app.getHttpServer();
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${String(address.port)}`;
  return baseUrl;
}

after(async () => {
  if (app) {
    await app.close();
    app = undefined;
  }
});

// Async-iterates an SSE response body, parsing each `event:`/`data:` block into
// a SessionEvent. Yields until the caller stops consuming. fetch over HTTP/1.1
// gives us a ReadableStream we decode line-by-line.
async function* readSseEvents(
  body: ReadableStream<Uint8Array>
): AsyncGenerator<SessionEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        return;
      }
      // Normalize CRLF so frame splitting is line-ending agnostic.
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      // SSE frames are separated by a blank line.
      let separator = buffer.indexOf('\n\n');
      while (separator !== -1) {
        const frame = buffer.slice(0, separator);
        buffer = buffer.slice(separator + 2);
        const dataLines = frame
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice('data:'.length).trimStart());
        if (dataLines.length > 0) {
          const payload = dataLines.join('\n');
          yield JSON.parse(payload) as SessionEvent;
        }
        separator = buffer.indexOf('\n\n');
      }
    }
  } finally {
    reader.releaseLock();
    await body.cancel().catch(() => undefined);
  }
}

test('golden path: approval round-trip over REST + SSE', async () => {
  const url = await boot();

  // 1) Create a session whose PermissionContext makes TaskList trigger `ask`.
  const createRes = await fetch(`${url}/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      permissionMode: 'default',
      rules: [
        { source: 'session', behavior: 'ask', toolName: 'TaskList' }
      ]
    })
  });
  assert.equal(createRes.status, 201, 'POST /sessions returns 201');
  const { id } = (await createRes.json()) as { id: string };
  assert.ok(id, 'create returns an id');

  // 2) Open the SSE stream BEFORE submitting (the buffer replay also covers the
  //    subscribe-after-submit case, but here we connect first). The abort
  //    controller lets us tear the long-lived connection down deterministically
  //    at the end so the test process can exit (an open SSE socket would
  //    otherwise keep the event loop alive).
  const sseAbort = new AbortController();
  const sseRes = await fetch(`${url}/sessions/${id}/events`, {
    headers: { accept: 'text/event-stream' },
    signal: sseAbort.signal
  });
  assert.equal(sseRes.status, 200, 'SSE stream opens');
  assert.ok(sseRes.body, 'SSE response has a body');
  const events = readSseEvents(sseRes.body);

  // Collects events until `predicate` is satisfied, returning the matched event.
  const seen: SessionEvent[] = [];
  async function until(
    predicate: (event: SessionEvent) => boolean
  ): Promise<SessionEvent> {
    for (;;) {
      const next = await events.next();
      assert.ok(!next.done, 'SSE stream ended before the expected event');
      seen.push(next.value);
      if (predicate(next.value)) {
        return next.value;
      }
    }
  }

  try {
    // 3) Submit a user message (fire-and-forget; progress flows over SSE).
    const msgRes = await fetch(`${url}/sessions/${id}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'List my tasks.' })
    });
    assert.equal(msgRes.status, 202, 'POST /messages acks with 202');

    // 4) Assert the ordered prefix: running -> tool_call -> approval_required.
    await until((e) => e.type === 'run_status' && e.status === 'running');
    const toolCall = await until((e) => e.type === 'tool_call');
    assert.equal(
      toolCall.type === 'tool_call' && toolCall.name,
      'TaskList',
      'tool_call is for TaskList'
    );
    const approval = await until((e) => e.type === 'approval_required');
    assert.equal(approval.type, 'approval_required');
    const requestId =
      approval.type === 'approval_required' ? approval.requestId : '';
    assert.ok(requestId, 'approval_required carries a requestId');

    // 5) Approve via POST /control with the captured requestId.
    const controlRes = await fetch(`${url}/sessions/${id}/control`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'approval_response',
        requestId,
        decision: { behavior: 'allow' }
      })
    });
    assert.equal(controlRes.status, 202, 'POST /control acks with 202');

    // 6) Assert the tool result (not an error) and final completion.
    const toolResult = await until((e) => e.type === 'tool_result');
    assert.equal(
      toolResult.type === 'tool_result' && toolResult.isError,
      undefined,
      'tool_result is not an error'
    );
    await until((e) => e.type === 'run_status' && e.status === 'completed');

    // 7) Assert an allow permission_decision was emitted somewhere in the run.
    const allowDecision = seen.find(
      (e) => e.type === 'permission_decision' && e.entry.behavior === 'allow'
    );
    assert.ok(
      allowDecision,
      'a permission_decision (allow) was emitted for the approved tool'
    );
  } finally {
    // Tear the long-lived SSE connection down so the process can exit: abort
    // the fetch, run the generator's finally (cancels the body), and dispose
    // the session (abort + unsubscribe + remove).
    sseAbort.abort();
    await events.return(undefined).catch(() => undefined);
    await fetch(`${url}/sessions/${id}`, { method: 'DELETE' }).catch(
      () => undefined
    );
  }
});

test('rejects malformed create and control bodies with 400', async () => {
  const url = await boot();

  const postJson = (path: string, body: unknown): Promise<Response> =>
    fetch(`${url}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });

  // A non-string workspace root would otherwise throw during path resolution
  // in acceptEdits mode rather than fail cleanly.
  const badRoots = await postJson('/sessions', {
    permissionMode: 'acceptEdits',
    workspaceRoots: [null]
  });
  assert.equal(badRoots.status, 400, 'non-string workspaceRoots -> 400');

  // A rule with an unknown behavior must not enter permission evaluation.
  const badRule = await postJson('/sessions', {
    rules: [{ source: 'session', behavior: 'maybe', toolName: 'TaskList' }]
  });
  assert.equal(badRule.status, 400, 'invalid rule.behavior -> 400');

  // A misspelled mode must 400 rather than silently fall back to `default`
  // (which would be less restrictive than the client asked for).
  const badMode = await postJson('/sessions', { permissionMode: 'readOnlyy' });
  assert.equal(badMode.status, 400, 'misspelled permissionMode -> 400');

  // A valid session for the control-body checks.
  const okRes = await postJson('/sessions', {});
  assert.equal(okRes.status, 201);
  const { id } = (await okRes.json()) as { id: string };

  try {
    // A non-object updatedInput would otherwise reach tool.call unvalidated,
    // since the runner uses it as the tool input without re-parsing.
    const badApproval = await postJson(`/sessions/${id}/control`, {
      type: 'approval_response',
      requestId: 'whatever',
      decision: { behavior: 'allow', updatedInput: 'not-an-object' }
    });
    assert.equal(badApproval.status, 400, 'string updatedInput -> 400');

    const unknownType = await postJson(`/sessions/${id}/control`, {
      type: 'nonsense'
    });
    assert.equal(unknownType.status, 400, 'unknown control type -> 400');
  } finally {
    await fetch(`${url}/sessions/${id}`, { method: 'DELETE' }).catch(
      () => undefined
    );
  }
});
