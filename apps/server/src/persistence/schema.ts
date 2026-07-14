import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

// Persistence schema. Two tables, intentionally un-normalized: the session row
// stores the full `SessionSnapshot` as a JSON blob (one row per session,
// upserted), and the audit log is its own append-only table queryable by
// `sessionId` for security review. No secrets are persisted — the snapshot
// excludes the apiKey by construction and nothing here adds one back.

// One row per live/persisted session. `snapshot` is the JSON of a
// `SessionSnapshot` (history / permission mode / workspace roots / todos);
// `updatedAt` is wall-clock milliseconds at the last save.
export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  snapshot: text('snapshot').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const checkpoints = sqliteTable(
  'checkpoints',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id').notNull(),
    parentCheckpointId: text('parent_checkpoint_id'),
    createdAt: integer('created_at').notNull(),
    runId: text('run_id'),
    label: text('label'),
    summary: text('summary'),
    snapshot: text('snapshot').notNull(),
    fileChanges: text('file_changes'),
  },
  (table) => [
    index('checkpoints_session_id_idx').on(table.sessionId),
    index('checkpoints_parent_checkpoint_id_idx').on(table.parentCheckpointId),
  ],
);

// Append-only permission audit. One row per recorded decision; never updated or
// deleted in normal operation. `reason` is the JSON of a
// `PermissionDecisionReason` (nullable — a decision may carry no reason). Indexed
// by `sessionId` so a session's audit trail is cheap to read back in order.
export const audit = sqliteTable(
  'audit',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    sessionId: text('session_id').notNull(),
    toolUseId: text('tool_use_id').notNull(),
    toolName: text('tool_name').notNull(),
    behavior: text('behavior').notNull(),
    reason: text('reason'),
    at: integer('at').notNull(),
  },
  (table) => [index('audit_session_id_idx').on(table.sessionId)],
);

export const projects = sqliteTable(
  'projects',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    path: text('path').notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [uniqueIndex('projects_path_idx').on(table.path)],
);

export const sessionMetadata = sqliteTable(
  'session_metadata',
  {
    sessionId: text('session_id').primaryKey(),
    projectId: text('project_id'),
    pinned: integer('pinned').notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [index('session_metadata_project_id_idx').on(table.projectId)],
);

export const installedPlugins = sqliteTable('installed_plugins', {
  id: text('id').primaryKey(),
  kind: text('kind').notNull(),
  registryName: text('registry_name').notNull(),
  title: text('title'),
  description: text('description'),
  version: text('version').notNull(),
  enabled: integer('enabled').notNull(),
  config: text('config').notNull(),
  installedAt: integer('installed_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export type SessionRow = typeof sessions.$inferSelect;
export type AuditRow = typeof audit.$inferSelect;
export type CheckpointRow = typeof checkpoints.$inferSelect;
export type ProjectRow = typeof projects.$inferSelect;
export type SessionMetadataRow = typeof sessionMetadata.$inferSelect;
export type InstalledPluginRow = typeof installedPlugins.$inferSelect;
