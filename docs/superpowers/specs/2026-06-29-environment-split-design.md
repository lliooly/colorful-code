# Development And Production Environment Split Design

## Context

The repository is a pnpm monorepo with a Nest server in `apps/server`, a Next web app in `apps/web`, and shared packages under `packages`. The current server entrypoint listens on `3001` and `0.0.0.0` directly in code. The web app has no explicit API base URL convention, and workspace scripts expose only generic `dev` and `build` commands.

## Goal

Separate development and production behavior through explicit environment files, typed runtime helpers where behavior is read in code, and clear scripts for local development versus production build/start flows.

This change should make it obvious which values are safe local defaults and which values must be supplied in production.

## Scope

- Add checked-in example environment files for the root, server, and web apps.
- Add ignored local environment files for developer and production overrides.
- Update server startup to read host, port, and CORS origins from environment variables.
- Add package scripts that distinguish development from production build/start commands.
- Document the environment variables and common commands in the existing app README or a nearby project README.
- Add focused tests for server environment parsing so invalid or missing values behave predictably.

## Non-Goals

- Do not add a deployment platform integration.
- Do not add secret management beyond environment variable conventions.
- Do not introduce runtime dependencies unless the existing framework requires them.
- Do not redesign application networking or authentication.

## Proposed Behavior

Development defaults should favor convenience:

- server host defaults to `127.0.0.1`
- server port defaults to `3001`
- CORS permits the local web origin by default
- web points at the local server URL

Production behavior should be explicit:

- server host can be supplied through `HOST`
- server port can be supplied through `PORT`
- allowed CORS origins are supplied through `CORS_ORIGIN`
- web API base URL is supplied through `NEXT_PUBLIC_API_BASE_URL`

If `PORT` is present but invalid, server startup configuration should fail early with a clear error instead of silently binding to an unexpected port.

## Environment Files

The repository should include example files only, not real secrets:

- `.env.example` for workspace-level conventions
- `apps/server/.env.example` for `HOST`, `PORT`, and `CORS_ORIGIN`
- `apps/web/.env.example` for `NEXT_PUBLIC_API_BASE_URL`

Local override files such as `.env`, `.env.local`, `.env.development.local`, and `.env.production.local` should remain gitignored.

## Scripts

The root package should keep the existing commands and add clearer aliases:

- `dev` for parallel local development
- `build` for all production build artifacts
- `start:prod` for starting built applications that support production runtime startup

The server package should expose:

- `dev` for Nest watch mode
- `build` for production compilation
- `start:prod` for `node dist/main.js`

The web package should expose:

- `dev` for Next dev mode
- `build` for Next production build
- `start:prod` for `next start`

## Testing

Add a small server unit test around environment parsing:

- missing values produce development-safe defaults
- valid numeric `PORT` is accepted
- invalid `PORT` throws a clear configuration error
- comma-separated `CORS_ORIGIN` values are parsed into the form expected by Fastify CORS

Existing typecheck, lint, server tests, and build commands should remain green.

## Open Decisions Resolved

Use a minimal in-repo helper for server environment parsing instead of adding a configuration package. The current needs are small, and keeping the helper local avoids introducing a larger configuration framework before the app has more runtime settings.
