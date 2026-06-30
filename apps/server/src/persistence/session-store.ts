import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';
import type {
  PermissionAuditEntry,
  PermissionDecisionReason,
  SessionSnapshot
} from '@colorful-code/tool-runtime';
import { SERVER_ENV } from '../config/config.module';
import type { ServerEnvironment } from '../config/environment';
import { openDatabase, type PersistenceDatabase } from './database';
import { audit, sessions, type AuditRow } from './schema';

// The persistence boundary over the drizzle/SQLite database. The session
// snapshot is stored as one upserted JSON row; the permission audit is appended
// to its own table and read back in insertion order. Nothing here ever stores a
// secret — the `SessionSnapshot` excludes the apiKey by construction and the
// audit columns carry only tool/permission metadata.
//
// JSON (de)serialization lives entirely in this class: callers hand it / receive
// back the runtime types (`SessionSnapshot`, `PermissionAuditEntry`), never the
// stringified columns.
@Injectable()
export class SessionStore implements OnModuleDestroy {
  private readonly handle: PersistenceDatabase;

  // The Nest path injects `SERVER_ENV` and opens the configured DB file. Tests
  // call `SessionStore.openAt(path)` to bind a temp/in-memory DB without the
  // container.
  constructor(@Inject(SERVER_ENV) env: ServerEnvironment) {
    this.handle = openDatabase(env.databasePath);
  }

  // Test/standalone constructor: opens a store at an explicit path (a temp file
  // or `:memory:`) bypassing the injected environment.
  static openAt(path: string): SessionStore {
    return new SessionStore({ databasePath: path } as ServerEnvironment);
  }

  private get db(): PersistenceDatabase['db'] {
    return this.handle.db;
  }

  // Upserts the session row: one row per session id, replacing snapshot +
  // updatedAt on conflict. The snapshot is JSON-serialized here.
  saveSnapshot(snapshot: SessionSnapshot): void {
    const row = {
      id: snapshot.id,
      snapshot: JSON.stringify(snapshot),
      updatedAt: Date.now()
    };
    this.db
      .insert(sessions)
      .values(row)
      .onConflictDoUpdate({
        target: sessions.id,
        set: { snapshot: row.snapshot, updatedAt: row.updatedAt }
      })
      .run();
  }

  // Reads back and parses the persisted snapshot, or `undefined` if the id has
  // never been saved.
  loadSnapshot(id: string): SessionSnapshot | undefined {
    const rows = this.db
      .select({ snapshot: sessions.snapshot })
      .from(sessions)
      .where(eq(sessions.id, id))
      .limit(1)
      .all();
    const row = rows[0];
    if (!row) {
      return undefined;
    }
    return JSON.parse(row.snapshot) as SessionSnapshot;
  }

  // Appends permission-audit entries for a session. Append-only: existing rows
  // are never touched. The `reason` is JSON-serialized (or NULL when absent). A
  // no-op for an empty batch.
  appendAudit(sessionId: string, entries: PermissionAuditEntry[]): void {
    if (entries.length === 0) {
      return;
    }
    const rows = entries.map((entry) => ({
      sessionId,
      toolUseId: entry.toolUseId,
      toolName: entry.toolName,
      behavior: entry.behavior,
      reason: entry.reason === undefined ? null : JSON.stringify(entry.reason),
      at: entry.at
    }));
    this.db.insert(audit).values(rows).run();
  }

  // Reads a session's audit trail in insertion order (ascending autoincrement
  // id), parsing each row back into a `PermissionAuditEntry`.
  listAudit(sessionId: string): PermissionAuditEntry[] {
    const rows = this.db
      .select()
      .from(audit)
      .where(eq(audit.sessionId, sessionId))
      .orderBy(asc(audit.id))
      .all();
    return rows.map((row) => this.toAuditEntry(row));
  }

  private toAuditEntry(row: AuditRow): PermissionAuditEntry {
    const reason =
      row.reason === null
        ? undefined
        : (JSON.parse(row.reason) as PermissionDecisionReason);
    return {
      toolUseId: row.toolUseId,
      toolName: row.toolName,
      behavior: row.behavior as PermissionAuditEntry['behavior'],
      at: row.at,
      ...(reason !== undefined ? { reason } : {})
    };
  }

  // Closes the underlying connection. Idempotent enough for shutdown — we only
  // ever call it once via Nest's lifecycle (or a test's `finally`) so a second
  // close on the raw bun:sqlite handle is never attempted.
  close(): void {
    this.handle.raw.close();
  }

  onModuleDestroy(): void {
    this.close();
  }
}
