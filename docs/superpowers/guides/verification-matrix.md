# Verification Matrix

This matrix defines the minimum checks for a Colorful Code change before it is
treated as dogfood-ready. Use the narrowest row that covers the files you
changed, then add any broader rows whose contracts you touched.

## Layers

| Layer      | What it protects                                         | Required command or check                                                                 |
| ---------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Runtime    | Tool descriptors, permissions, session engine, snapshots | `pnpm --filter @colorful-code/tool-runtime test`                                          |
| Server e2e | REST, SSE event mapping, model adapters, persistence     | `pnpm --filter @colorful-code/server test`                                                |
| Web        | Debug UI, route types, browser bundle                    | `pnpm --filter @colorful-code/web typecheck` and `pnpm --filter @colorful-code/web build` |
| Build      | Cross-package exports and compiled output                | `pnpm build`                                                                              |
| Formatting | Markdown, TS, CSS, config consistency                    | `pnpm format`                                                                             |

## Change Matrix

| Change type                                       | Must run                                                                               | Add when relevant                                                                                                          |
| ------------------------------------------------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Tool runtime logic under `packages/tool-runtime`  | `pnpm --filter @colorful-code/tool-runtime test`                                       | `pnpm --filter @colorful-code/server test` if session events, approval, snapshots, or tool results change                  |
| Server API, sessions, model adapters, persistence | `pnpm --filter @colorful-code/server test`                                             | `pnpm --filter @colorful-code/server typecheck`; real provider dogfood when provider config or adapter translation changes |
| Golden-path or e2e harness changes                | `pnpm --filter @colorful-code/server test`                                             | Repeat once after a failed run to prove app/session cleanup does not poison later tests                                    |
| Web Debug UI                                      | `pnpm --filter @colorful-code/web typecheck`; `pnpm --filter @colorful-code/web build` | Manual Debug UI dogfood against a live server when stream rendering, approvals, or restore UI changes                      |
| Shared package exports or workspace config        | `pnpm build`                                                                           | `pnpm lint` if source files changed                                                                                        |
| Docs-only guides/specs/plans                      | `pnpm format`                                                                          | The command named by the doc if it claims a verification result                                                            |
| Environment or secret handling                    | `pnpm --filter @colorful-code/server test`                                             | Manual missing-key and redaction checks from the dogfood guide                                                             |
| CLI behavior under `apps/cli`                     | `pnpm --filter @colorful-code/server test`                                             | Manual CLI dogfood with `pnpm agent:cli -- ...` once server behavior is involved                                           |

## P0 Dogfood Gate

Run these before using the branch as the base for more agent work:

```bash
pnpm --filter @colorful-code/tool-runtime test
pnpm --filter @colorful-code/server test
pnpm build
```

If frontend behavior changed, add:

```bash
pnpm --filter @colorful-code/web typecheck
pnpm --filter @colorful-code/web build
```

If provider adapters, approvals, restore, or CLI wiring changed, also run one
manual pass from `docs/superpowers/guides/dogfood-testing-guide.md`.

## Manual Dogfood Matrix

| Scenario            | Required evidence                                                                                                         |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Real provider smoke | One configured preset reaches `run_status: completed` after at least one tool call                                        |
| Approval allow      | `approval_required` appears, allow is sent, `permission_decision: allow`, `tool_result`, then `completed`                 |
| Approval deny       | `approval_required` appears, deny is sent, the tool does not mutate state, run ends without a false success claim         |
| Failure recovery    | A timed-out or invalid command surfaces as an error result and the next message in the same or new session still works    |
| Session restore     | Snapshot exists, live session can be disposed/restarted/restored, and a follow-up message continues from restored history |
| Debug UI            | Stream connects, events render live, approve/deny controls work, raw log matches server events                            |

## Evidence Template

Record this in PR notes, handoff notes, or the tracking issue:

```text
Commit:
Changed area:
Commands run:
Manual dogfood:
Provider/model:
Session id:
Result:
Known gaps:
```

## Exit Criteria

Do not mark a dogfood foundation task complete unless:

- The rows that match the changed files have fresh command output.
- The server golden path covers create -> SSE -> message -> approval -> tool_result -> completed.
- Any manual provider run records the provider, model, session id, and pass/fail result.
- Known failures are documented with a reproduction command and next owner.
