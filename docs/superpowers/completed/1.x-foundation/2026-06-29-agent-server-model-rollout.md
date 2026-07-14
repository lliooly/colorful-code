# Agent Server, Model Adapters, Debug UI, Persistence — Implementation Plan

## Context

The backend spine is committed (`bf95824`): `@colorful-code/tool-runtime` now has the
tool descriptor (Pillar 1), three-state permission policy (Pillar 2), and an in-process
session engine (Pillar 3 — `src/session/`: events, control channel, model interface +
scripted mock, turn loop, `Session` with approval correlation + snapshot/restore). The
`ModelClient` boundary exists but is only driven by a scripted mock; `apps/server` is an
empty NestJS (Fastify) scaffold.

This plan turns that spine into a runnable, observable agent: a server transport, real
model adapters, a minimal debug UI, persistence, and an end-to-end regression test. It
also records two architectural decisions that must be confronted early (cross-package
consumption, and a multi-round turn loop).

Design references: [tool-runtime spec](./2026-06-29-tool-runtime-clean-room-design.md),
[backend-spine spec](./2026-06-29-agent-backend-spine-design.md).

## Clean-room & security posture (unchanged)

- Adapt patterns, don't copy leaked source/prompts/telemetry. Original naming; display
  name **Colorful Code**; no `Claude Code` / `CLAUDE_CODE_*`.
- Calling third-party model APIs and using their official SDKs is fine — the clean-room
  rule targets leaked code, not API clients.
- **API keys are secrets:** never serialize into `SessionSnapshot`, never log. Keep them
  server-side (env / in-memory per session; encrypt if ever persisted).

---

## Two decisions to confront before/while coding

### A. Cross-package runtime consumption (the Step 0 prerequisite)

Today nothing consumes another workspace package's *built JS* at runtime; packages
resolve only via root tsconfig `paths` for typecheck, and there are no
`node_modules/@colorful-code/*` symlinks. For `apps/server` to `import` from
`@colorful-code/tool-runtime` at runtime, establish a real consumption convention:

- Recommended: `tool-runtime` builds to `dist/`; its `package.json` `exports` becomes
  `{ ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } }`; `pnpm install`
  creates the workspace symlink; Turbo `build` already has `dependsOn: ["^build"]` so the
  server builds after the runtime. The server runs compiled `dist/main.js` importing the
  symlinked `dist/index.js`.
- **Must verify the exports change does not break `apps/web` / `apps/server` typecheck**
  (they currently map workspace pkgs to `src` via root tsconfig `paths`; keep that for
  type resolution, or add a `development`/source export condition).
- Fallback: keep `exports: "./src/index.ts"` and have the server's build transpile the
  package source (Nest/tsc including the path) — simpler but couples build config.

This is genuinely uncertain; nail it first with a tiny spike (server imports
`createBuiltinTools` and boots) before building the SessionsModule on top.

### B. The turn loop must become multi-round (mandatory once a real model lands)

Current `src/session/turn.ts` iterates **one** `model.run` stream and dispatches
`tool_use` inline with `continue` on the same stream — fits the scripted mock only. Real
providers end the response at the tool call (`stop_reason: tool_use` /
`finish_reason: tool_calls`); you must run the tools, append results, and **issue a new
request**. Revised loop:

```
runTurn(deps):
  emit run_status: running
  loop:
    stream = model.run({ history, tools, signal })
    pendingToolUses = []
    for await event of stream:
      if signal.aborted: break
      text      -> accumulate + emit message_delta
      tool_use  -> push to pendingToolUses (do NOT run yet)
      end       -> break
    if signal.aborted: emit cancelled; return
    # history ordering matters: assistant-with-toolcalls FIRST, then results
    if assistantText or pendingToolUses:
      history.push({ role:'assistant', content: assistantText, toolCalls: pendingToolUses })
      emit message (if text)
    if pendingToolUses is empty:
      emit run_status: completed; return
    for each toolUse (scheduler decides concurrency):
      emit tool_call
      result = runner.run(toolUse)        # may park on approval (Pillar 2 -> session)
      flush audit -> permission_decision events; flush todos_updated
      emit tool_result
    history.push({ role:'tool', toolResults })   # results AFTER the assistant turn
    # loop: next model.run sees the appended results
  catch: aborted -> cancelled; else -> error + run_status: error
```

`ModelClient.run` semantics change to **"one model completion"**; `end` ⇒ that
completion finished; the loop owns re-invocation. This revision touches `turn.ts`,
`model.ts` (the scripted mock must yield per-round scripts), and `session.test.ts` (the 4
existing tests). Do this as **Step 1.5**, bundled with the real adapters.

---

## Model adapter design — 2 protocols + presets

You don't host models; you call external APIs. Almost everything except Claude speaks the
**OpenAI Chat Completions** protocol (GPT, DeepSeek, and most compatible endpoints). Claude
speaks the **Anthropic Messages** protocol. So the real shape is **two protocol adapters**,
and "Claude / DeepSeek / GPT" are **presets**, with "custom" being the general form.

```
ModelClient (interface, in tool-runtime)
  ├─ AnthropicModelClient   (Anthropic Messages protocol)   -> Claude
  └─ OpenAIModelClient      (OpenAI Chat Completions)        -> GPT / DeepSeek / custom-openai

type ModelProtocol = 'openai' | 'anthropic';
type ModelClientConfig = {
  protocol: ModelProtocol;
  baseURL?: string;     // preset default or user-supplied (custom / self-hosted)
  apiKey: string;       // secret — never persisted/logged
  model: string;
  maxTokens?: number;
  temperature?: number;
};
function createModelClient(config: ModelClientConfig): ModelClient;

const MODEL_PRESETS = [
  { id: 'claude',   label: 'Claude',   protocol: 'anthropic', baseURL: <anthropic default>, defaultModel: '<claude model>' },
  { id: 'deepseek', label: 'DeepSeek', protocol: 'openai',    baseURL: 'https://api.deepseek.com', defaultModel: 'deepseek-chat' },
  { id: 'openai',   label: 'OpenAI',   protocol: 'openai',    baseURL: <openai default>,   defaultModel: '<gpt model>' },
  { id: 'custom',   label: 'Custom',   protocol: /* user picks */, baseURL: /* user */,    defaultModel: /* user */ },
];
```

Each adapter does the real work (this is where the effort is, and it differs per protocol):
1. **Request translation:** `ConversationEntry[]` + `ToolDescriptor[]` → provider request.
   - Anthropic: top-level `system`, `tools` (name/description/`input_schema`), messages;
     tool results = `tool_result` content blocks in a user message.
   - OpenAI: `system`/`developer` role message, `tools` (function schema), messages; tool
     results = `role:"tool"` messages with `tool_call_id`.
2. **Streaming → `ModelTurnEvent`:** map text deltas → `text`; **accumulate tool-call
   argument deltas into complete JSON** (Anthropic `input_json_delta`; OpenAI
   `tool_calls[].function.arguments` fragments) then emit one `tool_use`; map
   `stop_reason`/`finish_reason` → `end`.
3. **Auth headers:** Anthropic `x-api-key` + `anthropic-version`; OpenAI `Authorization: Bearer`.

**Use official SDKs, don't hand-roll SSE parsing:** the `openai` SDK covers GPT + DeepSeek
+ any OpenAI-compatible custom endpoint via `baseURL`; `@anthropic-ai/sdk` covers Claude.
Two deps, both legitimate API clients.

**Placement:** the `ModelClient` interface + scripted mock stay in `tool-runtime`. The real
adapters (with SDK deps) live in **`apps/server`** initially (the only runtime consumer),
implementing the interface. Extract to a `packages/model-adapters` package later if the
desktop/CLI need them. **Caveat:** confirm the chosen DeepSeek model supports tool calling
(`deepseek-chat` does; reasoner-class/older variants can be flaky).

---

## Step-by-step plan

### Step 0 — Cross-package consumption spike (prerequisite)
Make `apps/server` import and run something from `@colorful-code/tool-runtime` (e.g. boot
Nest, call `createBuiltinTools()`/`describeTools()` in a health route). Land the
exports/build/symlink convention from Decision A. **Verify** `apps/web` + `apps/server`
still typecheck and the server boots importing the runtime.

### Step 1 — SessionsModule (REST + SSE)
NestJS `SessionsModule` managing an in-memory `Map<id, Session>`:
- `POST /sessions` → create a `Session`; model config is **per-session** (request-supplied
  config or server default as the fallback only); returns `{ id }`.
- `POST /sessions/:id/messages` `{ text }` → `session.submit(text)` (fire-and-forget; progress via SSE).
- `POST /sessions/:id/control` → `session.send(ControlMessage)` (approval_response / cancel / set_permission_mode).
- `GET /sessions/:id/events` → **SSE** stream of `SessionEvent` via `session.subscribe`.
- **Subscribe-before-submit / replay:** keep a small per-session event buffer with a cursor
  so a late or reconnecting subscriber catches up (also supports SSE `Last-Event-ID`).
- **Lifecycle:** dispose sessions on completion+idle TTL or explicit delete (abort + unsubscribe + remove).
- Keys/secrets stay server-side; never echo the apiKey back.

### Step 5 (pulled early) — e2e against the mock model
As soon as Step 1 exists, write the golden-path e2e (supertest + an SSE client) using the
**scripted mock**: create → subscribe → message → mock requests `Write` → assert
`approval_required` over SSE → `POST /control` allow → assert `tool_result` + `completed`.
This locks the transport contract before the real model and persistence land, and stays
green through them.

### Step 1.5 + 2 — Multi-round turn loop + real adapters
Apply Decision B (revise `turn.ts`, update the mock + `session.test.ts`). Then implement
`OpenAIModelClient` and `AnthropicModelClient` + `createModelClient` + `MODEL_PRESETS` in
`apps/server`. Wire `POST /sessions` to build the chosen client. Manual smoke test against
one real key per protocol.

### Step 3 — Minimal debug UI (apps/web)
Small but complete, not an IDE: message stream, tool call/result, **approval_required
modal**, permission-mode switch, raw event log, model-preset picker (+ custom fields). Can
start against the mock via Step 1's endpoints before the real model is ready. Its job is to
expose any awkwardness in the session API.

### Step 4 — Persistence (SQLite + Drizzle)
Persist `Session.snapshot()` as a row `{ id, snapshot(json: history/mode/todos), updatedAt }`;
keep the **audit log as its own append-only table** `{ sessionId, toolUseId, toolName,
behavior, reason, at }` (queryable for security). Restore via `Session.restore`. Don't
normalize every internal Map into tables yet; don't store apiKey.

## Sequencing

```
0 cross-package spike
  → 1 SessionsModule + SSE
  → 5 e2e (mock)            # contract lock; stays green afterward
  → 1.5 multi-round loop + 2 real adapters
  → 3 debug UI  ∥  4 persistence   # parallel / interchangeable
```

## Verification per step
- Each package/app: `typecheck`, `test`, `lint --max-warnings=0` stay clean.
- Step 0: server boots importing the runtime; web+server typecheck.
- Step 1/5: e2e golden path passes against the mock.
- Step 2: manual smoke per protocol (one OpenAI-compatible + Claude) reaches `completed`.
- Step 4: snapshot round-trips through SQLite (restore == pre-persist state).

## Open decisions (resolve when coding)
- Model config is **per-session** and chosen at `POST /sessions`; a server-global default is
  only the fallback when the request omits config.
- Server auth: none for local debug (bind localhost); add later if exposed.
- Drizzle + `better-sqlite3` vs raw driver — Drizzle for the typed schema + migrations.
- MCP lifecycle per session (connect/disconnect) — defer until a session needs MCP tools.
