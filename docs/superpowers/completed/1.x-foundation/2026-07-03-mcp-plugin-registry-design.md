# MCP Plugin Registry Design

## Goal

Add a lightweight internal plugin marketplace that lets users browse the public MCP Registry, install MCP servers, enable or disable installed servers, and have enabled servers automatically participate in new and restored agent sessions.

## Scope

This first version treats "plugin" as a user-facing name for MCP servers only. Skills and LSP remain managed by their existing paths or future settings screens. The implementation should avoid a custom curated marketplace because this is an internal product for a small technical team.

## User Experience

The sidebar `Puzzle` entry opens a plugin panel. Users can browse MCP Registry results, inspect the selected server's package-derived launch configuration, install it, and see installed status.

Settings exposes the installed MCP plugin list with enable, disable, trust-level, and uninstall controls. Disabled plugins remain installed but are not included in agent sessions. Uninstalled plugins are removed from local persistence.

## Backend Architecture

Add a `PluginsModule` with:

- `PluginsController`: HTTP API for registry browsing and local plugin management.
- `PluginsService`: thin MCP Registry client plus local installed-plugin operations.
- `PluginStore`: SQLite-backed persistence for installed MCP plugins.
- Registry conversion helpers: convert supported MCP Registry server packages into existing `McpServerConfig` values.

The session service merges enabled installed MCP plugins into the existing MCP resolution pipeline:

`project config -> env config -> enabled installed plugins -> request overrides`

Request overrides remain last so tests, CLI callers, and advanced users can override local installed plugins for one session.

## Data Model

Installed MCP plugins are stored locally:

```ts
type InstalledPlugin = {
  id: string;
  kind: 'mcp';
  registryName: string;
  title?: string;
  description?: string;
  version: string;
  enabled: boolean;
  config: McpServerConfigWithTrust;
  installedAt: number;
  updatedAt: number;
};
```

The persisted `config` must not include real secret values entered elsewhere. Registry-derived env variables are either omitted or stored as placeholders when the registry metadata declares a variable name but not a value.

## API

```txt
GET /plugins/registry/mcp?limit=&cursor=
GET /plugins/registry/mcp/:name
GET /plugins/installed
POST /plugins/install
PATCH /plugins/installed/:id
DELETE /plugins/installed/:id
```

`POST /plugins/install` accepts a registry server name and optional version. The server fetches the registry detail, derives a config, defaults trust to `ask`, persists it as enabled, and returns the installed plugin.

`PATCH /plugins/installed/:id` supports `enabled` and `trust` only.

## Registry Mapping

Support the package shapes needed for practical first use:

- `registryType: "npm"` plus `transport.type: "stdio"` maps to `command: "npx"` and `args: ["-y", identifier]`.
- `registryType: "pypi"` plus stdio maps to `command: "uvx"` and `args: [identifier]`.
- Packages with HTTP or SSE transport and a URL map to `type: "http"` or `type: "sse"` with that URL.

Unsupported package metadata causes install to fail with a clear 400 error. Browsing still shows unsupported entries.

## Error Handling

Registry failures return 502 from plugin registry endpoints. Malformed install or patch requests return 400. Unknown installed plugin IDs return 404.

If an installed plugin cannot connect during session startup, the existing MCP status event reports the failed server. A failed plugin should not prevent the user from managing or uninstalling it.

## Testing

Add backend tests for:

- Registry package mapping to `McpServerConfig`.
- Install/list/patch/delete persistence.
- Session creation merges enabled installed plugins.
- Disabled installed plugins are excluded.

Add focused frontend tests for API helpers and preference-independent installed-plugin state if practical. The first implementation may rely on backend coverage plus typecheck for the large single-page UI.
