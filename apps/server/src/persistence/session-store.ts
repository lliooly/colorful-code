import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { basename, resolve } from 'node:path';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import type {
  Checkpoint,
  FileChangeMetadata,
  PermissionAuditEntry,
  PermissionDecisionReason,
  SessionSnapshot,
} from '@colorful-code/tool-runtime';
import {
  type DatabaseProvider,
  type DatabaseConnection,
  type SynchronousTransactionResult,
} from './database-provider';
import { DATABASE_PROVIDER } from './database-provider.module';
import type { WriteDatabaseConnection } from './database-clock';
import {
  audit,
  checkpoints,
  projects,
  sessions,
  sessionMetadata,
  type AuditRow,
  type CheckpointRow,
  type ProjectRow,
  type SessionMetadataRow,
} from './schema';

export type ProjectRecord = {
  id: string;
  name: string;
  path: string;
  createdAt: number;
  updatedAt: number;
};

export type SessionMetadataRecord = {
  sessionId: string;
  projectId?: string;
  pinned: boolean;
  createdAt: number;
  updatedAt: number;
};

export type UpsertSessionMetadataInput = {
  sessionId: string;
  projectId?: string | null;
  pinned?: boolean;
};

function normalizeProjectPath(path: string): string {
  return resolve(path.trim());
}

function projectIdForPath(path: string): string {
  return (
    'project-' + createHash('sha256').update(path).digest('hex').slice(0, 20)
  );
}

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
export class SessionStore {
  private closed = false;

  get isClosed(): boolean {
    return this.closed;
  }

  constructor(
    @Inject(DATABASE_PROVIDER) private readonly provider: DatabaseProvider,
  ) {}

  private read<T>(operation: (database: DatabaseConnection['db']) => T): T {
    this.assertOpen();
    return this.provider.read((connection) => operation(connection.db));
  }

  private write<T>(
    operation: (database: WriteDatabaseConnection['db'], now: number) => T,
  ): Promise<T> {
    this.assertOpen();
    return this.provider.transaction<T>(
      (transaction) =>
        operation(
          transaction.database.db,
          transaction.now,
        ) as SynchronousTransactionResult<T>,
    );
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('SessionStore is closed');
  }

  now(): number {
    this.assertOpen();
    return this.provider.read((connection) =>
      this.provider.clock.now(connection),
    );
  }

  // Upserts the session row: one row per session id, replacing snapshot +
  // updatedAt on conflict. The snapshot is JSON-serialized here.
  saveSnapshot(snapshot: SessionSnapshot): Promise<void> {
    return this.write((database, now) => {
      const row = {
        id: snapshot.id,
        snapshot: JSON.stringify(snapshot),
        updatedAt: now,
      };
      database
        .insert(sessions)
        .values(row)
        .onConflictDoUpdate({
          target: sessions.id,
          set: { snapshot: row.snapshot, updatedAt: row.updatedAt },
        })
        .run();
    });
  }

  // Reads back and parses the persisted snapshot, or `undefined` if the id has
  // never been saved.
  loadSnapshot(id: string): SessionSnapshot | undefined {
    const rows = this.read((database) =>
      database
        .select({ snapshot: sessions.snapshot })
        .from(sessions)
        .where(eq(sessions.id, id))
        .limit(1)
        .all(),
    );
    const row = rows[0];
    if (!row) {
      return undefined;
    }
    return JSON.parse(row.snapshot) as SessionSnapshot;
  }

  listSessions(): Array<{ snapshot: SessionSnapshot; updatedAt: number }> {
    return this.read((database) =>
      database
        .select({ snapshot: sessions.snapshot, updatedAt: sessions.updatedAt })
        .from(sessions)
        .orderBy(desc(sessions.updatedAt), asc(sessions.id))
        .all(),
    ).map((row) => ({
      snapshot: JSON.parse(row.snapshot) as SessionSnapshot,
      updatedAt: row.updatedAt,
    }));
  }

  upsertProject(path: string): Promise<ProjectRecord> {
    const normalized = normalizeProjectPath(path);
    return this.write((database, now) => {
      const existingRow = database
        .select()
        .from(projects)
        .where(eq(projects.path, normalized))
        .limit(1)
        .all()[0];
      if (existingRow) {
        database
          .update(projects)
          .set({ updatedAt: now })
          .where(eq(projects.id, existingRow.id))
          .run();
        return this.toProjectRecord({ ...existingRow, updatedAt: now });
      }

      const row = {
        id: projectIdForPath(normalized),
        name: basename(normalized) || normalized,
        path: normalized,
        createdAt: now,
        updatedAt: now,
      };
      database.insert(projects).values(row).run();
      return this.toProjectRecord(row);
    });
  }

  listProjects(): ProjectRecord[] {
    return this.read((database) =>
      database
        .select()
        .from(projects)
        .orderBy(asc(projects.name), asc(projects.path))
        .all(),
    ).map((row) => this.toProjectRecord(row));
  }

  loadProject(id: string): ProjectRecord | undefined {
    const rows = this.read((database) =>
      database
        .select()
        .from(projects)
        .where(eq(projects.id, id))
        .limit(1)
        .all(),
    );
    const row = rows[0];
    return row ? this.toProjectRecord(row) : undefined;
  }

  loadProjectByPath(path: string): ProjectRecord | undefined {
    const normalized = normalizeProjectPath(path);
    const rows = this.read((database) =>
      database
        .select()
        .from(projects)
        .where(eq(projects.path, normalized))
        .limit(1)
        .all(),
    );
    const row = rows[0];
    return row ? this.toProjectRecord(row) : undefined;
  }

  deleteProject(id: string): Promise<boolean> {
    return this.write((database, now) => {
      const existing = database
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.id, id))
        .limit(1)
        .all()[0];
      if (!existing) return false;
      database
        .update(sessionMetadata)
        .set({ projectId: null, updatedAt: now })
        .where(eq(sessionMetadata.projectId, id))
        .run();
      database.delete(projects).where(eq(projects.id, id)).run();
      return true;
    });
  }

  upsertSessionMetadata(
    input: UpsertSessionMetadataInput,
  ): Promise<SessionMetadataRecord> {
    return this.write((database, now) => {
      const existingRow = database
        .select()
        .from(sessionMetadata)
        .where(eq(sessionMetadata.sessionId, input.sessionId))
        .limit(1)
        .all()[0];
      const existing = existingRow
        ? this.toSessionMetadataRecord(existingRow)
        : undefined;
      const row = {
        sessionId: input.sessionId,
        projectId:
          input.projectId === undefined
            ? (existing?.projectId ?? null)
            : input.projectId,
        pinned: (input.pinned ?? existing?.pinned) === true ? 1 : 0,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };

      database
        .insert(sessionMetadata)
        .values(row)
        .onConflictDoUpdate({
          target: sessionMetadata.sessionId,
          set: {
            projectId: row.projectId,
            pinned: row.pinned,
            updatedAt: row.updatedAt,
          },
        })
        .run();
      return this.toSessionMetadataRecord(row);
    });
  }

  loadSessionMetadata(sessionId: string): SessionMetadataRecord | undefined {
    const rows = this.read((database) =>
      database
        .select()
        .from(sessionMetadata)
        .where(eq(sessionMetadata.sessionId, sessionId))
        .limit(1)
        .all(),
    );
    const row = rows[0];
    return row ? this.toSessionMetadataRecord(row) : undefined;
  }

  setSessionPinned(sessionId: string, pinned: boolean): Promise<boolean> {
    return this.write((database, now) => {
      const existingRow = database
        .select()
        .from(sessionMetadata)
        .where(eq(sessionMetadata.sessionId, sessionId))
        .limit(1)
        .all()[0];
      const snapshotExists =
        database
          .select({ id: sessions.id })
          .from(sessions)
          .where(eq(sessions.id, sessionId))
          .limit(1)
          .all().length > 0;
      if (!existingRow && !snapshotExists) return false;
      const row = {
        sessionId,
        projectId: existingRow?.projectId ?? null,
        pinned: pinned ? 1 : 0,
        createdAt: existingRow?.createdAt ?? now,
        updatedAt: now,
      };
      database
        .insert(sessionMetadata)
        .values(row)
        .onConflictDoUpdate({
          target: sessionMetadata.sessionId,
          set: {
            projectId: row.projectId,
            pinned: row.pinned,
            updatedAt: row.updatedAt,
          },
        })
        .run();
      return true;
    });
  }

  saveCheckpoint(checkpoint: Checkpoint): Promise<void> {
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
    return this.write((database) => {
      database
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
    });
  }

  listCheckpoints(sessionId: string): Checkpoint[] {
    const rows = this.read((database) =>
      database
        .select()
        .from(checkpoints)
        .where(eq(checkpoints.sessionId, sessionId))
        .orderBy(asc(checkpoints.createdAt), asc(checkpoints.id))
        .all(),
    );
    return rows.map((row) => this.toCheckpoint(row));
  }

  loadCheckpoint(
    sessionId: string,
    checkpointId: string,
  ): Checkpoint | undefined {
    const rows = this.read((database) =>
      database
        .select()
        .from(checkpoints)
        .where(
          and(
            eq(checkpoints.sessionId, sessionId),
            eq(checkpoints.id, checkpointId),
          ),
        )
        .limit(1)
        .all(),
    );
    const row = rows[0];
    return row ? this.toCheckpoint(row) : undefined;
  }

  // Appends permission-audit entries for a session. Append-only: existing rows
  // are never touched. The `reason` is JSON-serialized (or NULL when absent). A
  // no-op for an empty batch.
  appendAudit(
    sessionId: string,
    entries: PermissionAuditEntry[],
  ): Promise<void> {
    if (entries.length === 0) {
      return Promise.resolve();
    }
    const rows = entries.map((entry) => ({
      sessionId,
      toolUseId: entry.toolUseId,
      toolName: entry.toolName,
      behavior: entry.behavior,
      reason: entry.reason === undefined ? null : JSON.stringify(entry.reason),
      at: entry.at,
    }));
    return this.write((database) => {
      database.insert(audit).values(rows).run();
    });
  }

  // Reads a session's audit trail in insertion order (ascending autoincrement
  // id), parsing each row back into a `PermissionAuditEntry`.
  listAudit(sessionId: string): PermissionAuditEntry[] {
    const rows = this.read((database) =>
      database
        .select()
        .from(audit)
        .where(eq(audit.sessionId, sessionId))
        .orderBy(asc(audit.id))
        .all(),
    );
    return rows.map((row) => this.toAuditEntry(row));
  }

  deleteSession(sessionId: string): Promise<boolean> {
    return this.write((database) => {
      const hadSession =
        database
          .select({ id: sessions.id })
          .from(sessions)
          .where(eq(sessions.id, sessionId))
          .limit(1)
          .all().length > 0 ||
        database
          .select({ sessionId: sessionMetadata.sessionId })
          .from(sessionMetadata)
          .where(eq(sessionMetadata.sessionId, sessionId))
          .limit(1)
          .all().length > 0 ||
        database
          .select({ id: checkpoints.id })
          .from(checkpoints)
          .where(eq(checkpoints.sessionId, sessionId))
          .limit(1)
          .all().length > 0 ||
        database
          .select({ id: audit.id })
          .from(audit)
          .where(eq(audit.sessionId, sessionId))
          .limit(1)
          .all().length > 0;
      database.delete(audit).where(eq(audit.sessionId, sessionId)).run();
      database
        .delete(checkpoints)
        .where(eq(checkpoints.sessionId, sessionId))
        .run();
      database
        .delete(sessionMetadata)
        .where(eq(sessionMetadata.sessionId, sessionId))
        .run();
      database.delete(sessions).where(eq(sessions.id, sessionId)).run();
      return hadSession;
    });
  }

  deleteSessions(sessionIds: string[]): Promise<number> {
    if (sessionIds.length === 0) {
      return Promise.resolve(0);
    }
    return this.write((database) => {
      database.delete(audit).where(inArray(audit.sessionId, sessionIds)).run();
      database
        .delete(checkpoints)
        .where(inArray(checkpoints.sessionId, sessionIds))
        .run();
      database
        .delete(sessionMetadata)
        .where(inArray(sessionMetadata.sessionId, sessionIds))
        .run();
      database.delete(sessions).where(inArray(sessions.id, sessionIds)).run();
      return sessionIds.length;
    });
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

  private toProjectRecord(row: ProjectRow): ProjectRecord {
    return {
      id: row.id,
      name: row.name,
      path: row.path,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private toSessionMetadataRecord(
    row: SessionMetadataRow,
  ): SessionMetadataRecord {
    return {
      sessionId: row.sessionId,
      ...(row.projectId !== null ? { projectId: row.projectId } : {}),
      pinned: row.pinned === 1,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  // Store shutdown is logical only. The daemon-owned Provider closes the one
  // physical business connection after all stores and services stop.
  close(): void {
    if (this.closed) return;
    this.closed = true;
  }
}
