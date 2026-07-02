import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { and, asc, desc, eq } from 'drizzle-orm';
import type {
  Checkpoint,
  FileChangeMetadata,
  PermissionAuditEntry,
  PermissionDecisionReason,
  SessionSnapshot,
} from '@colorful-code/tool-runtime';
import { SERVER_ENV } from '../config/config.module';
import type { ServerEnvironment } from '../config/environment';
import { openDatabase, type PersistenceDatabase } from './database';
import {
  audit,
  checkpoints,
  sessions,
  type AuditRow,
  type CheckpointRow,
} from './schema';

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
      updatedAt: Date.now(),
    };
    this.db
      .insert(sessions)
      .values(row)
      .onConflictDoUpdate({
        target: sessions.id,
        set: { snapshot: row.snapshot, updatedAt: row.updatedAt },
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

  listSessions(): Array<{ snapshot: SessionSnapshot; updatedAt: number }> {
    return this.db
      .select({ snapshot: sessions.snapshot, updatedAt: sessions.updatedAt })
      .from(sessions)
      .orderBy(desc(sessions.updatedAt), asc(sessions.id))
      .all()
      .map((row) => ({
        snapshot: JSON.parse(row.snapshot) as SessionSnapshot,
        updatedAt: row.updatedAt,
      }));
  }

  saveCheckpoint(checkpoint: Checkpoint): void {
    const row = {
      id: checkpoint.id,
      sessionId: checkpoint.sessionId,
      parentCheckpointId: checkpoint.parentCheckpointId ?? null,
      createdAt: checkpoint.createdAt,
      runId: checkpoint.runId ?? null,
      label: checkpoint.label ?? null,
      summary: checkpoint.summary ?? null,
      snapshot: JSON.stringify(checkpoint.snapshot),
      fileChanges:
        checkpoint.fileChanges === undefined
          ? null
          : JSON.stringify(checkpoint.fileChanges),
    };
    this.db
      .insert(checkpoints)
      .values(row)
      .onConflictDoUpdate({
        target: checkpoints.id,
        set: {
          sessionId: row.sessionId,
          parentCheckpointId: row.parentCheckpointId,
          createdAt: row.createdAt,
          runId: row.runId,
          label: row.label,
          summary: row.summary,
          snapshot: row.snapshot,
          fileChanges: row.fileChanges,
        },
      })
      .run();
  }

  listCheckpoints(sessionId: string): Checkpoint[] {
    const rows = this.db
      .select()
      .from(checkpoints)
      .where(eq(checkpoints.sessionId, sessionId))
      .orderBy(asc(checkpoints.createdAt), asc(checkpoints.id))
      .all();
    return rows.map((row) => this.toCheckpoint(row));
  }

  loadCheckpoint(
    sessionId: string,
    checkpointId: string,
  ): Checkpoint | undefined {
    const rows = this.db
      .select()
      .from(checkpoints)
      .where(
        and(
          eq(checkpoints.sessionId, sessionId),
          eq(checkpoints.id, checkpointId),
        ),
      )
      .limit(1)
      .all();
    const row = rows[0];
    return row ? this.toCheckpoint(row) : undefined;
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
      at: entry.at,
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
      ...(reason !== undefined ? { reason } : {}),
    };
  }

  private toCheckpoint(row: CheckpointRow): Checkpoint {
    const fileChanges =
      row.fileChanges === null
        ? undefined
        : (JSON.parse(row.fileChanges) as FileChangeMetadata[]);
    return {
      id: row.id,
      sessionId: row.sessionId,
      ...(row.parentCheckpointId !== null
        ? { parentCheckpointId: row.parentCheckpointId }
        : {}),
      createdAt: row.createdAt,
      ...(row.runId !== null ? { runId: row.runId } : {}),
      ...(row.label !== null ? { label: row.label } : {}),
      ...(row.summary !== null ? { summary: row.summary } : {}),
      snapshot: JSON.parse(row.snapshot) as SessionSnapshot,
      ...(fileChanges !== undefined ? { fileChanges } : {}),
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
