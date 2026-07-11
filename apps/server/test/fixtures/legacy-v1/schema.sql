CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  snapshot TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  tool_use_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  behavior TEXT NOT NULL,
  reason TEXT,
  at INTEGER NOT NULL
);
CREATE INDEX audit_session_id_idx ON audit (session_id);
CREATE TABLE checkpoints (
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
CREATE INDEX checkpoints_session_id_idx ON checkpoints (session_id);
CREATE INDEX checkpoints_parent_checkpoint_id_idx ON checkpoints (parent_checkpoint_id);
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX projects_path_idx ON projects (path);
CREATE TABLE session_metadata (
  session_id TEXT PRIMARY KEY,
  project_id TEXT,
  pinned INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX session_metadata_project_id_idx ON session_metadata (project_id);
CREATE TABLE installed_plugins (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  registry_name TEXT NOT NULL,
  title TEXT,
  description TEXT,
  version TEXT NOT NULL,
  enabled INTEGER NOT NULL,
  config TEXT NOT NULL,
  installed_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
