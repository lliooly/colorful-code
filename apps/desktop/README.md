# Colorful Code Desktop

Thin Tauri 2 shell for the existing `apps/web` agent UI.

## What it owns

- Loads the existing `/agent` UI from `apps/web`.
- Provides native desktop commands that a browser cannot, starting with folder
  selection.
- Returns absolute local paths to the web UI so new sessions can send `cwd` and
  `workspaceRoots` to `apps/server`.
- Ensures a local agent server is reachable on `http://127.0.0.1:3367`; if one
  is not already running, the shell starts `bun apps/server/src/main.ts` from
  the repository root.

## Commands

From the repository root:

```bash
pnpm --filter @colorful-code/desktop dev
pnpm --filter @colorful-code/desktop build
pnpm --filter @colorful-code/desktop package:macos
```

Development starts the backend from source using Bun so it behaves like the
server package. Release builds compile the server into a macOS Tauri sidecar and
bundle it inside `Colorful Code.app`. Set `COLORFUL_CODE_REPO_ROOT` if dev mode
cannot infer the repository root, or `COLORFUL_CODE_SERVER_COMMAND` to override
the executable used to start the source server.
