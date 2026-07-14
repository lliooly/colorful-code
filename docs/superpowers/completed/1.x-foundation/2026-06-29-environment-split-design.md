# Development And Production Environment Split Design

## Context

The repository is a pnpm + Turborepo monorepo with a Nest server in `apps/server`, a
Next web app in `apps/web`, a desktop app in `apps/desktop`, and shared packages under
`packages`. The server entrypoint currently listens on `3001` / `0.0.0.0` hardcoded in
`apps/server/src/main.ts`; the web app has no API base-URL convention; workspace scripts
expose only generic `dev`/`build`; there is no `NODE_ENV` handling and no `.env*` files.
The next milestone (model adapters) introduces real **secrets** — provider API keys — so
the environment design must account for them now, not just host/port/CORS.

## Goal

Separate development and production behavior through an explicit `NODE_ENV`, checked-in
example env files, a small typed runtime helper that reads config in code, secret
conventions that keep API keys server-side, and clear dev vs production build/start
scripts. It must be obvious which values are safe local defaults and which values must be
supplied (and which are secrets) in production — and production must **fail fast** rather
than silently fall back to development defaults.

## Non-Goals

- No external secret manager / vault integration (Doppler, SOPS, cloud secret stores).
  Defining the env-var conventions and redaction for secrets **is** in scope.
- No deployment-platform integration (Docker/K8s/PaaS manifests).
- No new runtime dependencies unless the framework requires them. Env loading uses Node's
  built-in `--env-file` / `process.loadEnvFile` and Next's native env loading — no `dotenv`.
- No redesign of application networking or authentication.

## Environment selection (`NODE_ENV`)

`NODE_ENV` is the single canonical selector: `development` (default), `production`, or
`test`. Nest and Next already key off it; the server's config helper derives
`isProduction = NODE_ENV === 'production'` and uses it to decide between convenient
defaults and strict, must-be-supplied production values. (A separate logical `APP_ENV`
for staging-vs-prod is deferred — see Open Decisions.)

The core rule: **development defaults must never silently apply in production.** In
production, any required-but-missing value is a startup error, not a fallback.

## Configuration variables

| Variable | App | Phase | Required in prod | Secret | Dev default |
|---|---|---|---|---|---|
| `NODE_ENV` | all | both | yes (`production`) | no | `development` |
| `HOST` | server | runtime | no (defaults ok) | no | `127.0.0.1` |
| `PORT` | server | runtime | no (defaults ok) | no | `3001` |
| `CORS_ORIGIN` | server | runtime | **yes** (no fallback) | no | `http://localhost:3000` |
| `ANTHROPIC_API_KEY` | server | runtime | when Claude is used | **yes** | — |
| `OPENAI_API_KEY` | server | runtime | when GPT is used | **yes** | — |
| `DEEPSEEK_API_KEY` | server | runtime | when DeepSeek is used | **yes** | — |
| `NEXT_PUBLIC_API_BASE_URL` | web | **build** | yes | no | `http://localhost:3001` |

Notes:
- `HOST`/`PORT` keep dev-safe defaults in all environments (binding is not a security
  decision here); `CORS_ORIGIN` does **not** — see Dev vs Prod below.
- Provider keys are **per-provider, conditionally required**: only the key for a provider
  actually selected by a session is needed. A session that requests Claude with no
  `ANTHROPIC_API_KEY` fails with a clear error; you can run with just one provider's key.
- The "custom" provider's credentials are an open decision (env vs per-session BYO-key) —
  see Open Decisions.

## Secrets handling

API keys are the only secrets today, and they are the part a real project gets wrong.

- **Server-only.** Keys are read exclusively on the server. The web client never sees a
  key — it talks to the server, and the server calls the provider. This is why none of
  them may use the `NEXT_PUBLIC_` prefix: `NEXT_PUBLIC_*` values are inlined into the
  browser bundle and would leak the key publicly.
- **Never committed.** `.env.example` lists every secret key with an **empty/placeholder**
  value only. Real keys live in gitignored `.env*` (dev) or the orchestrator's injected
  env (prod).
- **Never logged.** Config dumps, the `/health` route, error messages, and telemetry must
  redact secret values. A config helper that prints resolved config masks any secret.

## Dev vs production behavior & fail-fast

Development favors convenience:
- server host `127.0.0.1`, port `3001`
- CORS permits the local web origin (`http://localhost:3000`) by default
- web points at the local server (`http://localhost:3001`)

Production is explicit and validated at startup:
- `HOST`/`PORT` may be supplied; defaults remain acceptable.
- `CORS_ORIGIN` is **required** — a comma-separated allowlist of exact origins. There is
  **no wildcard and no localhost fallback** in production; missing → startup error.
- `PORT`, if present, must parse to a valid port or startup fails with a clear message
  (no silent bind to an unexpected port).
- The selected provider's API key must be present when that provider is used, else a
  clear error (at session creation or startup, whichever first needs it).

Generalize the rule the original draft applied only to `PORT`: the config helper
validates the whole server configuration once at boot and, in production, fails fast on
any missing-required or malformed value.

## Loading env into `process.env`

Reading `process.env` assumes something populated it. The strategy is framework-aware and
dependency-free:

- **Server, development:** call Node's built-in `process.loadEnvFile()` early in
  bootstrap, guarded so it only runs when not in production and only if the file exists
  (it throws on a missing file). This works for both `nest start --watch` and
  `node dist/main.js` without a `dotenv` dependency.
- **Server, production:** do **not** load a file — env is injected by the runtime
  (shell/orchestrator). `process.loadEnvFile` is skipped when `NODE_ENV=production`.
- **Web:** Next.js loads `.env`, `.env.local`, `.env.development[.local]`,
  `.env.production[.local]` natively. No code needed; just follow its precedence rules.

## Environment files

Example files only, never real secrets:
- `.env.example` — workspace-level conventions (`NODE_ENV`).
- `apps/server/.env.example` — `HOST`, `PORT`, `CORS_ORIGIN`, and **empty placeholders**
  for `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `DEEPSEEK_API_KEY`.
- `apps/web/.env.example` — `NEXT_PUBLIC_API_BASE_URL`.

Gitignored: `.env`, `.env.local`, `.env.*.local` (and `.env.development`/`.env.production`
if used for non-secret per-env values — but never commit secrets to any of them).

## Turborepo env declaration

Turbo hashes task inputs for caching, and env vars consumed by a build affect its output.
Without declaring them, Turbo can serve a stale cached build with a wrong baked-in value,
and strict-env mode will not pass them through. Declare:
- `globalEnv: ["NODE_ENV"]` — affects all tasks.
- the web `build` task: `env: ["NEXT_PUBLIC_API_BASE_URL"]` — it is baked into the bundle.
- runtime-only, non-cached server secrets (`*_API_KEY`, `HOST`, `PORT`, `CORS_ORIGIN`)
  belong in `passThroughEnv` for the `start:prod`/`dev` tasks if needed — they must not
  enter the build cache hash.

## Next.js public-var build-time bake (caveat)

`NEXT_PUBLIC_API_BASE_URL` is inlined into the client bundle **at build time**. A single
web build artifact is therefore pinned to one API origin — the same prebuilt image cannot
be re-pointed at runtime by changing the env. Consequence: **build the web app per
environment** (dev/staging/prod each get their own build). If runtime re-pointing becomes
necessary later, switch to a runtime-config pattern (a server-served `/config` endpoint or
runtime env injection) rather than a `NEXT_PUBLIC_` var. Documented now to avoid the
"promote one image across environments" trap.

## Scripts

Root package — keep existing commands, add clearer aliases:
- `dev` — parallel local development (Turbo)
- `build` — all production build artifacts (Turbo, respects `^build`)
- `start:prod` — start built apps that support production runtime startup

Server package:
- `dev` — Nest watch mode (loads `.env` via `process.loadEnvFile` in bootstrap)
- `build` — production compilation
- `start:prod` — `node dist/main.js` (env from the orchestrator in real prod)

Web package:
- `dev` — Next dev mode
- `build` — Next production build (bakes `NEXT_PUBLIC_API_BASE_URL`)
- `start:prod` — `next start`

## Testing

A small server unit test around the config helper:
- missing values produce development-safe defaults (when `NODE_ENV !== 'production'`)
- valid numeric `PORT` is accepted; invalid `PORT` throws a clear configuration error
- comma-separated `CORS_ORIGIN` parses into the form Fastify CORS expects
- in `production`, a missing `CORS_ORIGIN` (and a malformed value) **fails fast** rather
  than falling back to the dev default
- resolved-config rendering masks secret values (no key appears in plaintext)

Existing typecheck, lint, server tests, and build must remain green. The session e2e runs
under `NODE_ENV=test` on an ephemeral port and needs no `.env` file.

## Open decisions

- **Custom-provider credentials:** server env (`CUSTOM_MODEL_BASE_URL` + a server-held
  key) vs **per-session BYO-key** supplied at `POST /sessions` (never persisted, never
  logged). Lean per-session BYO for the custom/self-hosted case; keep the named presets
  (Claude/GPT/DeepSeek) on server env. Decide when Step 2 lands.
- **`APP_ENV` for staging:** only if a third logical environment that runs with
  `NODE_ENV=production` but different config is needed. Deferred.

## Out of scope (noted)

- `apps/desktop` is not covered here. If/when it calls the API it needs its own runtime
  base-URL convention (Electron reads config at runtime, not via `NEXT_PUBLIC_`); to be
  specced separately.

## Open Decisions Resolved

Use a minimal in-repo helper for server environment parsing (reading + validating
`process.env` with `NODE_ENV`-aware defaults and secret masking) instead of adding a
configuration package or `@nestjs/config`. The current needs are small; a local helper
avoids a larger configuration framework before the app has more runtime settings.
