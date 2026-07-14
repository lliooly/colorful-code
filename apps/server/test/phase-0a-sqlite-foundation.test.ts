import { strict as assert } from 'node:assert';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Database } from 'bun:sqlite';
import { eq } from 'drizzle-orm';
import { integer, sqliteTable } from 'drizzle-orm/sqlite-core';
import { FixedDatabaseClock } from '../src/persistence/database-clock';
import { createTestDatabaseProvider } from './support/database-provider-testing';
import { createTestDatabase } from './support/test-database-factory';
import {
  LEGACY_1X_SCHEMA_CHECKSUM,
  inspectLegacySchema,
  legacySchemaChecksum,
} from '../src/persistence/legacy-schema-baseline';
import { bootstrapMigrations } from '../src/persistence/migration-bootstrap';
import { audit, sessions } from '../src/persistence/schema';
import { DataDirectoryInstanceLock } from '../src/runtime/data-directory-instance-lock';
import { createLegacyFixture } from '../scripts/create-legacy-fixture';

const gateParent = sqliteTable('gate_parent', {
  id: integer('id').primaryKey(),
});
const gateChild = sqliteTable('gate_child', {
  parentId: integer('parent_id')
    .notNull()
    .references(() => gateParent.id),
});

test('Phase 0A empty database transacts with fixed time, closes, and restarts', async () => {
  const fixedNow = 1_750_000_000_000;
  const database = await createTestDatabase({ kind: 'empty', now: fixedNow });
  try {
    assert.equal(
      (await readdir(join(database.dataDirectory, 'backups'))).length,
      1,
    );
    await database.provider.transaction(({ database: connection, now }) => {
      connection.db
        .insert(sessions)
        .values({ id: 'empty-gate', snapshot: '{}', updatedAt: now })
        .run();
    });
    assert.equal(
      database.provider.read((connection) => database.clock.now(connection)),
      fixedNow,
    );

    await database.restart();

    assert.deepEqual(
      database.provider.read((connection) =>
        connection.db
          .select({ id: sessions.id, updatedAt: sessions.updatedAt })
          .from(sessions)
          .where(eq(sessions.id, 'empty-gate'))
          .all(),
      ),
      [{ id: 'empty-gate', updatedAt: fixedNow }],
    );
  } finally {
    await database.close();
  }
});

test('Phase 0A lifecycle adopts 1.x, transacts with database time, closes, and restarts', async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'colorful-code-p0a-'));
  const databasePath = join(dataDirectory, 'colorful-code.db');
  createLegacyFixture(databasePath);
  let lock = await DataDirectoryInstanceLock.acquire(dataDirectory);
  try {
    await bootstrapMigrations(databasePath);
    const schemaProbe = new Database(databasePath);
    try {
      assert.equal(
        legacySchemaChecksum(inspectLegacySchema(schemaProbe)),
        LEGACY_1X_SCHEMA_CHECKSUM,
      );
      schemaProbe.exec(
        'CREATE TABLE gate_parent(id INTEGER PRIMARY KEY); CREATE TABLE gate_child(parent_id INTEGER NOT NULL REFERENCES gate_parent(id));',
      );
    } finally {
      schemaProbe.close(true);
    }
    let provider = createTestDatabaseProvider(databasePath, {
      clock: new FixedDatabaseClock(1_800_000_000_000),
    });
    assert.equal(provider.diagnostics.journalMode, 'wal');
    assert.equal(provider.diagnostics.foreignKeys, true);
    await provider.transaction(({ database, now }) => {
      database.db.insert(gateParent).values({ id: 1 }).run();
      database.db.insert(gateChild).values({ parentId: 1 }).run();
      database.db
        .insert(audit)
        .values({
          sessionId: 'legacy-session-1',
          toolUseId: 'gate-use',
          toolName: 'Gate',
          behavior: 'allow',
          reason: null,
          at: now,
        })
        .run();
    });
    await assert.rejects(
      provider.transaction(({ database }) => {
        database.db.insert(gateChild).values({ parentId: 999 }).run();
      }),
    );
    await provider.close();
    const cleanupProbe = new Database(databasePath, { readwrite: true });
    try {
      cleanupProbe.exec('DROP TABLE gate_child; DROP TABLE gate_parent;');
    } finally {
      cleanupProbe.close(true);
    }
    await lock.release();

    lock = await DataDirectoryInstanceLock.acquire(dataDirectory);
    await bootstrapMigrations(databasePath);
    provider = createTestDatabaseProvider(databasePath);
    try {
      assert.equal(
        provider.read((connection) =>
          connection.db
            .select()
            .from(audit)
            .where(eq(audit.toolUseId, 'gate-use'))
            .all(),
        ).length,
        1,
      );
    } finally {
      await provider.close();
    }
  } finally {
    await lock.release();
    await rm(dataDirectory, { recursive: true, force: true });
  }
});

test('Phase 0A factory closes the WAL migration loop and restarts under one instance lock', async () => {
  const database = await createTestDatabase({
    kind: 'wal-uncheckpointed',
    now: 1_900_000_000_000,
  });
  try {
    const diagnosticsBeforeRestart = database.provider.diagnostics;
    assert.equal(database.provider.diagnostics.journalMode, 'wal');
    assert.equal(database.provider.diagnostics.foreignKeys, true);
    assert.deepEqual(
      {
        busyTimeoutMs: database.provider.diagnostics.busyTimeoutMs,
        synchronous: database.provider.diagnostics.synchronous,
        tempStore: database.provider.diagnostics.tempStore,
        trustedSchema: database.provider.diagnostics.trustedSchema,
        queryOnly: database.provider.diagnostics.queryOnly,
      },
      {
        busyTimeoutMs: 250,
        synchronous: 'full',
        tempStore: 'memory',
        trustedSchema: false,
        queryOnly: false,
      },
    );
    await database.provider.transaction(({ database: connection, now }) => {
      connection.db
        .insert(audit)
        .values({
          sessionId: 'legacy-session-1',
          toolUseId: 'factory-gate-use',
          toolName: 'Gate',
          behavior: 'allow',
          reason: null,
          at: now,
        })
        .run();
    });
    assert.equal(
      database.provider.read((connection) =>
        connection.db
          .select()
          .from(audit)
          .where(eq(audit.toolUseId, 'wal-fixture-use'))
          .all(),
      ).length,
      1,
    );
    assert.equal(
      database.provider.read((connection) =>
        connection.db
          .select()
          .from(audit)
          .where(eq(audit.toolUseId, 'factory-gate-use'))
          .all(),
      )[0]?.at,
      1_900_000_000_000,
    );

    await database.restart();
    assert.equal(database.provider.diagnostics.journalMode, 'wal');
    assert.deepEqual(database.provider.diagnostics, diagnosticsBeforeRestart);
    assert.equal(
      database.provider.read((connection) =>
        connection.db
          .select()
          .from(audit)
          .where(eq(audit.toolUseId, 'factory-gate-use'))
          .all(),
      ).length,
      1,
    );
  } finally {
    await database.close();
  }
});
