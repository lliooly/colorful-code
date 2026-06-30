import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Database } from 'bun:sqlite';
import { drizzle, type BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import * as schema from './schema';
import { SCHEMA_DDL } from './schema';

// The typed drizzle database bound to our schema. Carried alongside the raw
// bun:sqlite handle so callers can `close()` the underlying connection on
// shutdown (drizzle has no close of its own). The backend runs on Bun (the
// Tauri sidecar target), so `bun:sqlite` is the embedded driver — no native
// node addon to compile or bundle per platform.
export type PersistenceDatabase = {
  db: BunSQLiteDatabase<typeof schema>;
  raw: Database;
};

// In-memory sentinel paths that bun:sqlite understands directly — they have no
// parent directory to create.
function isInMemoryPath(path: string): boolean {
  return path === ':memory:' || path === '' || path.startsWith('file::memory:');
}

// Opens (creating if needed) the SQLite file at `path`, ensures the schema, and
// returns the drizzle handle. For a real file path the parent directory is
// created first so a fresh checkout with `./data/colorful-code.db` just works.
// `:memory:` (and temp files) are supported for tests. The DDL is idempotent, so
// re-opening an existing DB is a no-op.
export function openDatabase(path: string): PersistenceDatabase {
  if (!isInMemoryPath(path)) {
    mkdirSync(dirname(path), { recursive: true });
  }

  const raw = new Database(path);
  // WAL improves concurrent read/write behaviour for a file DB; harmless for an
  // in-memory DB.
  raw.exec('PRAGMA journal_mode = WAL;');
  raw.exec(SCHEMA_DDL);

  const db = drizzle(raw, { schema });
  return { db, raw };
}
