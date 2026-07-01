import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

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
  updatedAt: integer('updated_at').notNull()
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
    fileChanges: text('file_changes')
  },
  (table) => [
    index('checkpoints_session_id_idx').on(table.sessionId),
    index('checkpoints_parent_checkpoint_id_idx').on(table.parentCheckpointId)
  ]
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
    at: integer('at').notNull()
  },
  (table) => [index('audit_session_id_idx').on(table.sessionId)]
);

export type SessionRow = typeof sessions.$inferSelect;
export type AuditRow = typeof audit.$inferSelect;
export type CheckpointRow = typeof checkpoints.$inferSelect;

// Idempotent DDL run on init. We do not pull in drizzle-kit / migration tooling
// for now; `database.ts` execs this against the raw bun:sqlite handle so the
// tables (and the audit index) exist before any drizzle query. `IF NOT EXISTS`
// keeps re-opening an existing DB a no-op. Column names mirror the drizzle
// schema above (snake_case), so the two must stay in lock-step.
export const SCHEMA_DDL = `
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    snapshot TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    tool_use_id TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    behavior TEXT NOT NULL,
    reason TEXT,
    at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS audit_session_id_idx ON audit (session_id);
  CREATE TABLE IF NOT EXISTS checkpoints (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    parent_checkpoint_id TEXT,
    created_at INTEGER NOT NULL,
    run_id TEXT,
    label TEXT,
    summary TEXT,
    snapshot TEXT NOT NULL,
    file_changes TEXT
  );
  CREATE INDEX IF NOT EXISTS checkpoints_session_id_idx ON checkpoints (session_id);
  CREATE INDEX IF NOT EXISTS checkpoints_parent_checkpoint_id_idx ON checkpoints (parent_checkpoint_id);
`;
