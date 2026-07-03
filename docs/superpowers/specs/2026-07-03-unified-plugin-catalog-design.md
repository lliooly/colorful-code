# Unified Plugin Catalog Design

## Goal

Extend the plugin hub from MCP-only to a unified internal catalog for MCP servers, skills, and LSP servers. Users should browse all three from the sidebar plugin card, install records into local app persistence, enable or disable installed plugins, and uninstall them.

## Scope

This is an internal product for a small technical team. The first unified version should keep installation intentionally lightweight:

- MCP continues to use the public MCP Registry and derives runnable MCP configs.
- Skills use a curated catalog entry that records where a skill lives and how it should be installed manually or by a future downloader.
- LSP uses a curated catalog entry that derives an `LspServerConfig` and can be merged into new and restored sessions.

The unified hub should not silently clone skill repositories or globally install language servers in this version. Catalog entries expose install hints instead.

## User Experience

The sidebar `Puzzle` entry opens a card-sized plugin dialog. The card contains filter tabs for All, MCP, Skills, and LSP. Registry cards show plugin kind, title, description, version, source name, and an install button. Installed cards show kind, title, version, enabled switch, and delete control. MCP installed cards additionally show trust policy because MCP tools participate in permission decisions.

Settings remains the place to manage already-installed MCP, Skills, and LSP. The plugin dialog is the discovery and quick-management surface.

## Architecture

The existing `PluginsModule` becomes the unified plugin boundary:

- `plugin-types.ts` defines common installed plugin types and per-kind config types.
- `plugin-registry.ts` keeps the MCP Registry client and MCP config conversion.
- `plugin-catalog.ts` defines curated Skill and LSP catalog entries.
- `plugin-store.ts` persists all plugin kinds in the existing `installed_plugins` table.
- `plugins.service.ts` routes install requests by `kind`.
- `plugins.controller.ts` exposes MCP registry endpoints plus curated skill and LSP catalog endpoints.

The existing `installed_plugins` table is already generic enough: `kind`, `registry_name`, `version`, and JSON `config` can store all three kinds. No database migration is required.

## Session Integration

Enabled MCP plugins continue to merge into `mcpServers`:

`project config -> env config -> enabled installed MCP plugins -> request overrides`

Enabled LSP plugins merge into `lspServers`:

`project config -> env config -> enabled installed LSP plugins -> request overrides`

Skills are persisted and manageable but are not injected into agent runtime yet because this app currently discovers skills outside the server session API. Installed skill records preserve source metadata for the next runtime-discovery pass.

## Catalogs

Skills catalog entries:

```ts
{
  kind: 'skill';
  name: 'github:owner/repo/path';
  title: 'GitHub Skills Pack';
  description: 'Skill pack description';
  version: 'latest';
  config: {
    type: 'skill';
    source: 'github';
    repository: 'owner/repo';
    path: 'skills/example';
    entry: 'SKILL.md';
    installHint: 'Install into a configured skill root.';
  }
}
```

LSP catalog entries:

```ts
{
  kind: 'lsp';
  name: 'typescript-language-server';
  title: 'TypeScript LSP';
  description: 'TypeScript and JavaScript language intelligence.';
  version: 'latest';
  config: {
    command: 'typescript-language-server',
    args: ['--stdio'],
    language: 'typescript',
    fileExtensions: ['.ts', '.tsx', '.js', '.jsx']
  }
}
```

## API

Existing endpoints remain:

```text
GET /plugins/registry/mcp?limit=&cursor=
GET /plugins/registry/mcp/:name
GET /plugins/installed
POST /plugins/install
PATCH /plugins/installed/:id
DELETE /plugins/installed/:id
```

New endpoints:

```text
GET /plugins/registry/skills
GET /plugins/registry/lsp
```

`POST /plugins/install` accepts:

```json
{
  "kind": "mcp",
  "registryName": "io.example/server",
  "version": "latest"
}
```

```json
{
  "kind": "skill",
  "registryName": "github:colorful-code/skills/code-review"
}
```

```json
{
  "kind": "lsp",
  "registryName": "typescript-language-server"
}
```

For backward compatibility, missing `kind` means `mcp`.

`PATCH /plugins/installed/:id` supports `enabled` for all kinds and `trust` for MCP only.

## Error Handling

Registry failures for MCP still return 502. Unknown curated catalog entries return 404 through the install path. Unsupported MCP registry packages return 400. Invalid patch requests return 400. Unknown installed plugin IDs return 404.

If an enabled LSP command is not installed locally, the existing LSP status event reports a failed server. Users can disable or delete it from the plugin manager.

## Tests

Backend tests cover:

- Skill and LSP catalog endpoints return curated entries.
- Installing a skill stores a `kind: "skill"` plugin record.
- Installing an LSP stores a `kind: "lsp"` record.
- Enabled LSP plugins merge into session `lspServers`.
- Disabled LSP plugins are excluded.
- MCP behavior remains backward compatible.

Frontend validation uses typecheck and lint. The large single-page UI can remain covered by API shape and build-time checks for this increment.
