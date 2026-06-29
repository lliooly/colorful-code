import test from "node:test";
import assert from "node:assert/strict";
import {
  Session,
  createBuiltinTools,
  createScriptedModelClient,
  type ModelTurnEvent,
  type PermissionContext,
  type SessionEvent,
} from "../index.js";

// Spins the microtask/macrotask queue so parked promises (approvals) settle and
// emitted events flush before assertions run.
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

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
  assert.fail("timed out waiting for: " + label);
}

test("a turn streams text, runs a read-only tool, and completes in order", async () => {
  const script: ModelTurnEvent[] = [
    { type: "text", text: "Listing tasks." },
    { type: "tool_use", toolUseId: "call-1", name: "TaskList", input: {} },
    { type: "end" },
  ];
  const session = new Session({
    model: createScriptedModelClient(script, { loop: false }),
    tools: createBuiltinTools(),
  });

  const events: SessionEvent[] = [];
  session.subscribe((event) => events.push(event));

  await session.submit("list my tasks");

  const order = events.map((event) => event.type);
  assert.deepEqual(order, [
    "run_status", // running
    "message_delta",
    "tool_call",
    "permission_decision",
    "tool_result",
    "message",
    "run_status", // completed
  ]);
  assert.equal((events[0] as { status: string }).status, "running");
  assert.equal((events.at(-1) as { status: string }).status, "completed");

  const toolResult = events.find((event) => event.type === "tool_result");
  assert.ok(toolResult);
  assert.equal((toolResult as { isError?: boolean }).isError, undefined);
});

test("an ask parks on approval_required and completes after an allow response", async () => {
  // `default` mode + a destructive built-in (the model calls Write) routes to
  // `ask`, which the session surfaces as a correlated approval prompt.
  const script: ModelTurnEvent[] = [
    {
      type: "tool_use",
      toolUseId: "call-1",
      name: "Write",
      input: { path: "/tmp/colorful-session-ignored.txt", content: "x" },
    },
    { type: "end" },
  ];
  const permissionContext: PermissionContext = {
    mode: "default",
    workspaceRoots: [],
    rules: [{ source: "session", behavior: "ask", toolName: "Write" }],
  };
  const session = new Session({
    model: createScriptedModelClient(script, { loop: false }),
    tools: createBuiltinTools(),
    permissionContext,
  });

  const events: SessionEvent[] = [];
  session.subscribe((event) => events.push(event));

  const done = session.submit("write a file");

  await waitFor(
    () => events.some((event) => event.type === "approval_required"),
    "approval_required",
  );
  const approval = events.find((event) => event.type === "approval_required");
  assert.ok(approval);
  const requestId = (approval as { requestId: string }).requestId;
  assert.equal((approval as { name: string }).name, "Write");

  // Not yet completed while parked.
  assert.ok(
    !events.some(
      (event) =>
        event.type === "run_status" &&
        (event as { status: string }).status === "completed",
    ),
  );

  session.send({
    type: "approval_response",
    requestId,
    decision: { behavior: "allow" },
  });
  await done;

  const decision = events.find(
    (event) => event.type === "permission_decision",
  );
  assert.ok(decision);
  assert.equal((decision as { entry: { behavior: string } }).entry.behavior, "allow");
  assert.equal(
    (events.at(-1) as { status: string }).status,
    "completed",
  );
});

test("cancel mid-run yields run_status:cancelled and auto-denies a pending approval", async () => {
  const script: ModelTurnEvent[] = [
    {
      type: "tool_use",
      toolUseId: "call-1",
      name: "Write",
      input: { path: "/tmp/colorful-session-cancel.txt", content: "x" },
    },
    { type: "end" },
  ];
  const permissionContext: PermissionContext = {
    mode: "default",
    workspaceRoots: [],
    rules: [{ source: "session", behavior: "ask", toolName: "Write" }],
  };
  const session = new Session({
    model: createScriptedModelClient(script, { loop: false }),
    tools: createBuiltinTools(),
    permissionContext,
  });

  const events: SessionEvent[] = [];
  session.subscribe((event) => events.push(event));

  const done = session.submit("write a file");

  await waitFor(
    () => events.some((event) => event.type === "approval_required"),
    "approval_required",
  );

  session.send({ type: "cancel" });
  await done;

  // The denied (auto-deny) tool result surfaces as an error, and the run ends
  // cancelled rather than completed.
  const statuses = events
    .filter((event) => event.type === "run_status")
    .map((event) => (event as { status: string }).status);
  assert.ok(statuses.includes("cancelled"));
  assert.ok(!statuses.includes("completed"));
});

test("snapshot then restore preserves history and permission mode", async () => {
  const script: ModelTurnEvent[] = [
    { type: "text", text: "Hello there." },
    { type: "end" },
  ];
  const session = new Session({
    model: createScriptedModelClient(script, { loop: false }),
    tools: createBuiltinTools(),
    permissionContext: { mode: "plan", workspaceRoots: ["/work"], rules: [] },
  });

  await session.submit("say hello");

  const snapshot = session.snapshot();
  assert.equal(snapshot.permissionMode, "plan");
  assert.equal(snapshot.history.length, 2); // user + assistant
  assert.equal(snapshot.history[0]?.role, "user");
  assert.equal(snapshot.history[1]?.content, "Hello there.");

  const restored = Session.restore(snapshot, {
    model: createScriptedModelClient([{ type: "end" }], { loop: false }),
    tools: createBuiltinTools(),
  });

  assert.equal(restored.id, session.id);
  assert.equal(restored.permissionContext.mode, "plan");
  const restoredSnapshot = restored.snapshot();
  assert.deepEqual(restoredSnapshot.history, snapshot.history);
  assert.equal(restoredSnapshot.permissionMode, "plan");
});
