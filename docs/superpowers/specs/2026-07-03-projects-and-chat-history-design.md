# Projects and Chat History Design

## Goal

Rework the agent sidebar so conversation history matches the Codex desktop model:

- Projects manage imported local folders and contain chats created for that folder.
- Chats contains standalone conversations that are not bound to a local folder.
- Users can pin, delete, and clear persisted history.

This change fixes the current flat history problem where dogfood sessions, folder-bound sessions, and standalone chats all appear in one undifferentiated list.

## User Model

There are two conversation scopes:

1. Project chat
   - Created from an imported local folder.
   - Session creation sends `cwd` and `workspaceRoots` for that folder.
   - Appears under that project only.

2. Standalone chat
   - Created from the global Chats entry.
   - Session creation does not send `cwd` or `workspaceRoots`.
   - Appears under Chats only.

Pinned state is scoped by where the chat appears. A pinned project chat is promoted within its project. A pinned standalone chat is promoted within Chats.

Delete and clear history are hard deletes. Deleted sessions, checkpoints, audit entries, and session metadata are removed from persistence.

## Sidebar Behavior

The sidebar has two primary history sections:

1. Projects
   - Shows imported folder names.
   - Import uses the existing Tauri folder picker.
   - Imported projects persist across refresh and app restart.
   - Selecting a project scopes new chat creation to that project's path.
   - Each project shows its recent chats beneath it.
   - Project chats are ordered by pinned first, then newest activity.
   - Long project chat lists collapse behind "Show more".

2. Chats
   - Shows standalone chats only.
   - New chat from this section creates an unscoped session.
   - Chats are ordered by pinned first, then newest activity.

Each visible chat row supports:

- Open or restore the chat.
- Pin or unpin.
- Delete.

The history area supports:

- Clear all standalone chats.
- Clear project chats for a single project.
- Clear all history, including project chats and standalone chats.

Imported projects are not deleted by clearing chat history unless the user explicitly removes the project.

## Data Model

Add persisted project and session metadata.

### Projects

`projects` table:

- `id`: stable project id.
- `name`: folder display name.
- `path`: normalized absolute folder path, unique.
- `created_at`: wall-clock milliseconds.
- `updated_at`: wall-clock milliseconds.

### Session metadata

Add a `session_metadata` table instead of changing the `SessionSnapshot` shape:

- `session_id`: primary key, references the persisted session id.
- `project_id`: nullable project id.
- `pinned`: integer boolean.
- `created_at`: wall-clock milliseconds.
- `updated_at`: wall-clock milliseconds.

Derivation rules:

- New project chats write `project_id`.
- New standalone chats write `project_id = null`.
- Legacy sessions without metadata are classified from `snapshot.cwd`:
  - If `cwd` matches an imported project path, treat as that project chat.
  - Otherwise treat as standalone chat.
- The server may create metadata lazily for legacy sessions during list operations.

## API

Add project endpoints:

- `GET /projects` returns imported projects.
- `POST /projects` imports a path and returns the existing or new project.
- `DELETE /projects/:id` removes the project only. Existing sessions are converted to standalone unless a future destructive option is added.

Extend session endpoints:

- `POST /sessions` accepts optional `projectId`.
  - If `projectId` is present, the server resolves the project and applies its `path` as `cwd` and `workspaceRoots` unless explicitly overridden.
  - If `projectId` is absent, the session is standalone unless explicit `cwd` is provided by non-UI clients.
- `GET /sessions` returns grouped history:
  - `projects: Array<ProjectWithChats>`
  - `chats: SessionSummary[]`
- `PATCH /sessions/:id` accepts `{ pinned?: boolean }`.
- `DELETE /sessions/:id` hard-deletes the session from persistence.
- `DELETE /sessions` hard-deletes session history. Query params define scope:
  - no params: delete all sessions and related rows.
  - `projectId=<id>`: delete sessions in one project.
  - `scope=standalone`: delete standalone sessions only.

Keep existing restore, checkpoint, audit, and events endpoints.

## Frontend State

Replace the current flat `sessionHistory` rendering with grouped history state:

- `projects`: persisted project list with embedded chat summaries.
- `standaloneChats`: unscoped chat summaries.
- `selectedScope`: either `{ type: 'project'; projectId }` or `{ type: 'chats' }`.

Creation rules:

- New chat while a project is selected calls `POST /sessions` with `projectId`.
- New chat while Chats is selected calls `POST /sessions` without `projectId`, `cwd`, or `workspaceRoots`.
- Importing a folder calls `POST /projects`, refreshes grouped history, then selects that project.

The existing local `createWorkspaceProject()` helper becomes a display helper only or is removed.

## Error Handling

- Importing the same folder returns the existing project.
- Importing an invalid path returns a 400.
- Deleting an active live session cancels and closes it before removing persisted rows.
- Restoring a deleted session returns 404.
- Pinning an unknown session returns 404.
- Clearing history never deletes imported project records unless the project delete endpoint is called.

## Tests

Server tests:

- Importing the same project path is idempotent.
- Creating a project chat stores metadata and uses the project path as `cwd` and `workspaceRoots`.
- Creating a standalone chat does not inherit the selected project path.
- `GET /sessions` groups project chats separately from standalone chats.
- Pinned chats sort before unpinned chats within the same scope.
- `DELETE /sessions/:id` hard-deletes session, checkpoints, audit, and metadata.
- `DELETE /sessions?scope=standalone` deletes only standalone chats.
- `DELETE /sessions?projectId=<id>` deletes only that project's chats.

Frontend tests:

- Sidebar renders Projects and Chats as separate sections.
- Project chats do not appear in standalone Chats.
- Standalone chats do not appear under Projects.
- Pin and delete actions call the expected API helpers.
- Creating from project scope sends `projectId`.
- Creating from Chats scope sends no project context.

## Out of Scope

- Soft archive.
- Remote project sync.
- Nested project detection.
- Per-project model settings.
- Deleting files from the imported folder.
