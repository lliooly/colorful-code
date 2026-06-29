# Colorful Code

## Environments

`NODE_ENV` selects the runtime mode: `development`, `test`, or `production`.
Development defaults are convenient; production must provide explicit CORS
origins.

Copy example files before local development:

```bash
cp .env.example .env
cp apps/server/.env.example apps/server/.env
cp apps/web/.env.example apps/web/.env.local
```

Server variables:

- `HOST`: server bind host, default `127.0.0.1`
- `PORT`: server port, default `3001`
- `CORS_ORIGIN`: comma-separated browser origins allowed to call the server;
  required in production
- `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `DEEPSEEK_API_KEY`: server-only
  provider secrets

Web variables:

- `NEXT_PUBLIC_API_BASE_URL`: public API base URL baked into the Next.js browser
  bundle at build time

Provider API keys must never use the `NEXT_PUBLIC_` prefix. Next.js exposes
those values to browser code.

## Commands

```bash
pnpm dev
pnpm build
pnpm start:prod
pnpm lint
pnpm typecheck
```

Build the web app separately per environment because `NEXT_PUBLIC_API_BASE_URL`
is baked into the generated bundle.
