import { Database } from 'bun:sqlite';
import { drizzle, type BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import * as schema from './schema';

// The typed drizzle database bound to our schema. Carried alongside the raw
// bun:sqlite handle so callers can `close()` the underlying connection on
// shutdown (drizzle has no close of its own). The backend runs on Bun (the
// Tauri sidecar target), so `bun:sqlite` is the embedded driver — no native
// node addon to compile or bundle per platform.
export type PersistenceDatabase = {
  db: BunSQLiteDatabase<typeof schema>;
  raw: Database;
};

export type PersistenceDrizzleDatabase = BunSQLiteDatabase<typeof schema>;

export function createDrizzleDatabase(
  raw: Database,
): PersistenceDrizzleDatabase {
  return drizzle(raw, { schema });
}
