# Dogfood Testing Guide

How to exercise every critical path of the Colorful Code agent pipeline before
building the frontend or sub-agent system.

Use this guide together with
[`verification-matrix.md`](./verification-matrix.md): run the automated checks
for the files you changed first, then use this guide for the manual provider,
approval, failure-recovery, and restore drills.

## Prerequisites

```bash
# 1. Configure API keys
cd /Users/shishishi/Desktop/colorful-code/apps/server
cp .env.example .env
# Edit .env — fill at least one:
#   ANTHROPIC_API_KEY=sk-ant-...
#   OPENAI_API_KEY=sk-...
#   DEEPSEEK_API_KEY=sk-...

# 2. Start the server (keep this terminal open)
cd /Users/shishishi/Desktop/colorful-code
bun run apps/server/src/main.ts
# Expected: "Server listening on http://127.0.0.1:3367"

# 3. CLI alias
alias colorful='bun run /Users/shishishi/Desktop/colorful-code/apps/cli/src/main.ts'
# Or from the repo root:
pnpm agent:cli -- --help
```

## Run metadata

Record this before each manual pass:

```text
Commit:
Server command:
Provider/model:
Permission mode:
Session id:
Database path:
CLI or Debug UI:
```

## Baseline automated checks

Run these before starting a real provider dogfood pass:

```bash
pnpm --filter @colorful-code/tool-runtime test
pnpm --filter @colorful-code/server test
```

Add the web checks when using the Debug UI:

```bash
pnpm --filter @colorful-code/web typecheck
pnpm --filter @colorful-code/web build
```

Expected evidence:

- [ ] Runtime tests pass
- [ ] Server tests pass, including `golden path: approval round-trip over REST + SSE`
- [ ] Web typecheck/build pass when Debug UI is in scope

## Provider setup matrix

| Provider                    | CLI mode                                                  | Required env or flags                       | First check                                      |
| --------------------------- | --------------------------------------------------------- | ------------------------------------------- | ------------------------------------------------ |
| Claude                      | `--preset claude`                                         | `ANTHROPIC_API_KEY` in `apps/server/.env`   | Text plus one read-only tool reaches `completed` |
| OpenAI                      | `--preset openai`                                         | `OPENAI_API_KEY` in `apps/server/.env`      | Text plus one read-only tool reaches `completed` |
| DeepSeek                    | `--preset deepseek`                                       | `DEEPSEEK_API_KEY` in `apps/server/.env`    | Text plus one read-only tool reaches `completed` |
| Custom OpenAI-compatible    | `--api-key`, `--protocol openai`, `--model`, `--base-url` | No server env key required for that session | BYO key is not returned in snapshot or logs      |
| Custom Anthropic-compatible | `--api-key`, `--protocol anthropic`, `--model`            | No server env key required for that session | BYO key is not returned in snapshot or logs      |

Missing-key recovery check:

```bash
colorful --preset claude \
  --cwd /Users/shishishi/Desktop/colorful-code \
  --prompt "Say hello."
```

Checklist when the key is intentionally absent:

- [ ] Session creation fails with a 400-class message
- [ ] Error text does not print the key value
- [ ] Starting a later session with a configured provider still works

---

## Phase 1 — Smoke tests (5 min)

Verify the basic pipeline isn't broken. Run all of these from the project root.

### Test 1: Simplest conversation

```bash
colorful --preset claude \
  --cwd /Users/shishishi/Desktop/colorful-code \
  --prompt "Say hello and tell me what directory you are in."
```

Checklist:

- [ ] `session xxx` printed to stderr
- [ ] Text streams character-by-character to stdout
- [ ] Ends with `run completed` (not `error` / `cancelled`)

### Test 2: Read a file

```bash
colorful --preset claude \
  --cwd /Users/shishishi/Desktop/colorful-code \
  --prompt "Read the file apps/server/.env.example and tell me what provider keys are configured."
```

Checklist:

- [ ] `> Read ...` appears in stderr (tool_call event)
- [ ] `< ...` appears in stderr (tool_result event)
- [ ] stdout describes `.env.example` contents correctly
- [ ] Agent did NOT read the real `.env` (secrets safe)

### Test 3: List a directory

```bash
colorful --preset claude \
  --cwd /Users/shishishi/Desktop/colorful-code \
  --prompt "List the top-level files and directories in this project."
```

Checklist:

- [ ] Uses Bash or Glob tool
- [ ] Output matches actual project structure

---

## Phase 2 — Core flow verification (15 min)

Exercise each major subsystem.

### Test 4: Multi-turn conversation

```bash
colorful --preset claude \
  --cwd /Users/shishishi/Desktop/colorful-code \
  --prompt "First, list the packages directory. Then, based on what you see, read the package.json of the first package you find. Finally, tell me its name and version."
```

Checklist:

- [ ] Two distinct tool calls in stderr (Glob/Bash then Read)
- [ ] Second tool call uses results from the first
- [ ] Final answer references actual file contents, not hallucinated

### Test 5: Write file + approval flow

```bash
colorful --preset claude \
  --cwd /Users/shishishi/Desktop/colorful-code \
  --prompt "Create a file named test-output.txt in the current directory with the content 'dogfood test passed'."
```

Checklist:

- [ ] `approval required for Write` appears in stderr
- [ ] Allow path: typing `y` makes the tool execute and creates the file with correct content
- [ ] Deny path: typing `n` denies the tool, stderr shows a deny reason, and the file is not created
- [ ] Re-run and try both paths; each path gets a fresh session id
- [ ] `GET /sessions/<session-id>/audit` records the matching `allow` or `deny` decision

### Test 6: Destructive Bash approval

```bash
colorful --preset claude \
  --cwd /Users/shishishi/Desktop/colorful-code \
  --prompt "Delete the file test-output.txt that was just created."
```

Checklist:

- [ ] `rm` triggers approval (destructive command)
- [ ] Allow path: file is deleted
- [ ] Deny path: file is preserved
- [ ] Denying `rm` does not poison a later allowed tool call in the same provider/server run

### Test 6b: Approval while using Debug UI

Use `http://localhost:3000/agent` with the same prompt from Test 5.

Checklist:

- [ ] `approval_required` card/modal shows the tool name and input
- [ ] Approve sends `approval_response` and the run reaches `completed`
- [ ] Deny sends `approval_response` with `behavior: deny`
- [ ] Raw event log contains `approval_required`, `permission_decision`, and the terminal `run_status`

---

## Phase 3 — Subsystem stress tests (20 min)

These target the subsystems most likely to have bugs.

### Test 7: Long conversation + compaction

```bash
colorful --preset claude \
  --cwd /Users/shishishi/Desktop/colorful-code \
  --prompt "I want you to explore this project thoroughly.
  1. Read README.md
  2. Read package.json
  3. Read pnpm-workspace.yaml
  4. Read turbo.json
  5. List all files in packages/tool-runtime/src/core/
  6. Read packages/tool-runtime/src/core/tool.ts
  7. Read packages/tool-runtime/src/session/session.ts
  8. Read apps/server/src/sessions/sessions.service.ts
  After reading all of these, give me a summary of the project architecture."
```

Checklist:

- [ ] At least 8 tool calls execute
- [ ] **Critical:** no context-window errors (compaction should trigger before overflow)
- [ ] Architecture summary references actual file contents, not hallucinated
- [ ] `context_compacted` event may appear in stderr (depends on threshold config)

### Test 8: Error recovery — command timeout

```bash
colorful --preset claude \
  --cwd /Users/shishishi/Desktop/colorful-code \
  --prompt "Run this command: sleep 120. Then tell me what happened."
```

Checklist:

- [ ] Bash tool times out (default 30s), result has `isError: true`
- [ ] Agent handles the error gracefully — does not crash
- [ ] Agent reports the timeout; does not claim success
- [ ] A follow-up session can still complete a simple read-only prompt

### Test 9: Cross-provider

```bash
# DeepSeek (if key configured)
colorful --preset deepseek \
  --cwd /Users/shishishi/Desktop/colorful-code \
  --prompt "Read apps/server/package.json and tell me what the server package name is."

# OpenAI (if key configured)
colorful --preset openai \
  --cwd /Users/shishishi/Desktop/colorful-code \
  --prompt "Read apps/server/package.json and tell me what the server package name is."

# Custom endpoint (bring your own key)
colorful --api-key sk-your-key --protocol openai --model gpt-4o \
  --base-url https://api.openai.com/v1 \
  --cwd /Users/shishishi/Desktop/colorful-code \
  --prompt "Say hello."
```

Checklist:

- [ ] Each provider completes at least one round of tool use
- [ ] Anthropic adapter emits `usage` events with token counts
- [ ] OpenAI-compatible adapter emits `usage` (if provider supports `stream_options.include_usage`)

### Test 9b: Failure recovery after bad model config

```bash
colorful --api-key fake-key --protocol openai --model missing-model \
  --base-url https://api.invalid/v1 \
  --cwd /Users/shishishi/Desktop/colorful-code \
  --prompt "Say hello."
```

Checklist:

- [ ] The run fails without hanging the CLI
- [ ] The error does not expose provider secrets
- [ ] Re-running Test 1 with a valid provider works without restarting the server

---

## Phase 4 — Edge cases (15 min)

### Test 10: Large file read (truncation)

```bash
colorful --preset claude \
  --cwd /Users/shishishi/Desktop/colorful-code \
  --prompt "Read the pnpm-lock.yaml file. It may be truncated; if so, tell me how many lines you got."
```

Checklist:

- [ ] Read result is truncated (truncation footer present)
- [ ] Agent acknowledges the truncation; does not pretend it read the whole file

### Test 11: Multi-file edit

```bash
colorful --preset claude \
  --cwd /Users/shishishi/Desktop/colorful-code \
  --prompt "Create three files in a new directory test-dogfood/: a.txt with 'aaa', b.txt with 'bbb', c.txt with 'ccc'. Use separate Write calls."
```

Checklist:

- [ ] Each Write triggers its own approval (in `default` mode)
- [ ] All three files created with correct content
- [ ] Denying one does not affect the others

### Test 12: Cancel mid-run

```bash
colorful --preset claude \
  --cwd /Users/shishishi/Desktop/colorful-code \
  --prompt "List every file in the project recursively, then count them."

# Press Ctrl+C while it's listing files
```

Checklist:

- [ ] Ctrl+C exits the CLI cleanly — no hang
- [ ] Server-side session is disposed (not leaking memory)

---

## Phase 5 — Debug UI (10 min)

```bash
# Start the web dev server (separate terminal)
cd /Users/shishishi/Desktop/colorful-code/apps/web
bun run dev
# Open http://localhost:3000/agent in browser
```

Manual checklist:

- [ ] Select preset → Create session → "stream connected" indicator shows
- [ ] Send a message → streaming text appears in real time
- [ ] Send a tool-requiring instruction → tool_call + tool_result cards render correctly
- [ ] `approval_required` modal appears → Approve and Deny buttons both work
- [ ] Switch permission mode → subsequent behavior respects the new mode
- [ ] Raw event log panel appends events in real time
- [ ] Cancel run button interrupts an in-progress turn
- [ ] New session button creates a fresh session, previous state cleared

---

## Phase 6 — Persistence + restore (5 min)

```bash
# Run a session with at least one tool call first, then:

# Test 13: Snapshot persistence
curl -s http://127.0.0.1:3367/sessions/<session-id>/snapshot | jq .
```

Checklist:

- [ ] Response contains `history`, `permissionMode`, `workspaceRoots`, `todos`
- [ ] `history` has `user` / `assistant` / `tool` entries
- [ ] No `apiKey` anywhere in the snapshot

```bash
# Test 14: Audit trail
curl -s http://127.0.0.1:3367/sessions/<session-id>/audit | jq .
```

Checklist:

- [ ] One audit entry per tool call
- [ ] `behavior` field is correct (`allow` / `deny` / `ask`)
- [ ] `reason` field is populated

### Test 15: Session restore drill

Use a persistent `DATABASE_PATH` rather than `:memory:`. Start the server, run a
session that reaches `completed`, then restore it through the HTTP API.

```bash
# 1. Capture a session id from the CLI stderr: "session <session-id>"
SESSION_ID=<session-id>

# 2. Confirm the snapshot exists.
curl -s http://127.0.0.1:3367/sessions/$SESSION_ID/snapshot | jq .

# 3. Restart the server, then restore the session.
curl -s -X POST http://127.0.0.1:3367/sessions/$SESSION_ID/restore | jq .

# 4. Continue the restored session.
curl -s -X POST http://127.0.0.1:3367/sessions/$SESSION_ID/messages \
  -H 'content-type: application/json' \
  -d '{"text":"Continue from the restored history and summarize what we did."}'
```

Checklist:

- [ ] Snapshot exists before restart
- [ ] Snapshot contains no `apiKey`
- [ ] `POST /restore` returns the same session id
- [ ] A later message produces live stream events after restore
- [ ] Restore of an already-live session is idempotent

---

## Result tracking template

Copy this for each test run:

```
Test #: ___
Provider: claude / openai / deepseek / custom
Model: ___
Session id: ___
Prompt: ___
Result: PASS / FAIL
Issue: (if any) ___
```

---

## Troubleshooting

| Symptom                         | Likely cause                                                                 |
| ------------------------------- | ---------------------------------------------------------------------------- |
| `Failed to create session: 400` | API key missing or malformed                                                 |
| `Failed to create session: 404` | Server not started                                                           |
| Streaming stops with no error   | SSE connection dropped; check server logs                                    |
| Tool call with no follow-up     | Approval stuck — CLI waiting for `y/n` input                                 |
| `run_status: error`             | Model returned malformed tool-call JSON                                      |
| Restore returns 404             | Session never reached a persisted terminal state, or `DATABASE_PATH` changed |
| Compaction never triggers       | Token threshold too high, or estimate function underestimating               |
| `Failed to open event stream`   | CORS misconfiguration or wrong `--api-base`                                  |

---

## Cleanup

```bash
rm -f /Users/shishishi/Desktop/colorful-code/test-output.txt
rm -rf /Users/shishishi/Desktop/colorful-code/test-dogfood/
```
