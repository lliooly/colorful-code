import { strict as assert } from 'node:assert';
import { existsSync } from 'node:fs';
import { test } from 'node:test';
import type {
  Checkpoint,
  PermissionAuditEntry,
  SessionSnapshot,
} from '@colorful-code/tool-runtime';
import { createTestDatabaseProvider } from './support/database-provider-testing';
import { SessionStore } from '../src/persistence/session-store';
import {
  createTestDatabase,
  TestDatabaseClock,
  withRawTestConnection,
} from './support/test-database-factory';

// ---------------------------------------------------------------------------
// Persistence round-trips against a REAL temp-file SQLite DB (not just
// `:memory:`) so the file path resolution, parent-dir creation, and on-disk
// (de)serialization are all exercised. Each test opens its own temp dir, runs
// the assertions, and cleans up (close + rm) in a `finally`.
// ---------------------------------------------------------------------------

// Creates a temp dir + a nested DB path inside it (the nesting proves the store
// creates the parent directory), opens a store, and runs `body` against it,
// guaranteeing the connection is closed and the temp dir removed afterward.
async function withTempStore(
  body: (store: SessionStore, dbPath: string) => void | Promise<void>,
  options: {
    clock?: TestDatabaseClock;
    failCheckpointDelete?: string;
  } = {},
): Promise<void> {
  const database = await createTestDatabase({
    kind: 'migrated',
    clock: options.clock,
  });
  if (options.failCheckpointDelete !== undefined) {
    const message = options.failCheckpointDelete.replaceAll("'", "''");
    withRawTestConnection(database, 'lock-holder', (raw) => {
      raw.exec(`CREATE TRIGGER test_fail_checkpoint_delete
        BEFORE DELETE ON checkpoints
        BEGIN
          SELECT RAISE(ABORT, '${message}');
        END`);
    });
  }
  const store = new SessionStore(database.provider);
  try {
    await body(store, database.databasePath);
  } finally {
    store.close();
    await database.close();
  }
}

function sampleSnapshot(
  overrides: Partial<SessionSnapshot> = {},
): SessionSnapshot {
  return {
    id: 'session-1',
    cwd: '/work/project',
    history: [
      { role: 'user', content: 'List my tasks.' },
      { role: 'assistant', content: 'There are no tasks yet.' },
    ],
    permissionMode: 'default',
    workspaceRoots: ['/work/project'],
    todos: [{ content: 'ship persistence', status: 'pending' }],
    ...overrides,
  };
}

test('saveSnapshot + loadSnapshot round-trip through a real file DB', async () => {
  await withTempStore(async (store, dbPath) => {
    const snapshot = sampleSnapshot();
    await store.saveSnapshot(snapshot);

    // The file must actually exist on disk (proves it is not an in-memory DB).
    assert.ok(existsSync(dbPath), 'the SQLite file was created on disk');

    const loaded = store.loadSnapshot('session-1');
    assert.deepEqual(
      loaded,
      snapshot,
      'loaded snapshot deep-equals the saved one',
    );

    assert.equal(
      store.loadSnapshot('does-not-exist'),
      undefined,
      'unknown id loads as undefined',
    );
  });
});

test('current SessionStore reads the normal 1.x fixture after baseline adoption', async () => {
  const database = await createTestDatabase({ kind: 'legacy-1x' });
  const store = new SessionStore(database.provider);
  try {
    const snapshot = store.loadSnapshot('legacy-session-1') as
      | (SessionSnapshot & {
          modelConfig?: Record<string, string>;
        })
      | undefined;
    assert.equal(snapshot?.id, 'legacy-session-1');
    assert.deepEqual(snapshot?.history, []);
    assert.deepEqual(snapshot?.modelConfig, {
      presetId: 'fixture-openai-compatible',
      protocol: 'openai',
      model: 'fixture-model',
    });
    assert.deepEqual(
      store
        .listCheckpoints('legacy-session-1')
        .map(({ id, parentCheckpointId }) => ({ id, parentCheckpointId })),
      [
        { id: 'legacy-checkpoint-1', parentCheckpointId: undefined },
        {
          id: 'legacy-checkpoint-2',
          parentCheckpointId: 'legacy-checkpoint-1',
        },
      ],
    );
    assert.deepEqual(
      store.listAudit('legacy-session-1').map(({ toolUseId }) => toolUseId),
      ['legacy-tool-use-1', 'legacy-tool-use-2'],
    );
    assert.equal(store.loadSessionMetadata('legacy-session-1')?.pinned, true);
    assert.equal(store.listProjects()[0]?.path, 'fixture-workspace');
  } finally {
    store.close();
    await database.close();
  }
});

test('deleteSession rolls back every table when a delete step fails', async () => {
  await withTempStore(
    async (store) => {
      const snapshot = sampleSnapshot();
      await store.saveSnapshot(snapshot);
      await store.saveCheckpoint({
        id: 'checkpoint-delete',
        sessionId: snapshot.id,
        createdAt: 1,
        snapshot,
      });
      await store.appendAudit(snapshot.id, [
        {
          toolUseId: 'call-delete',
          toolName: 'Read',
          behavior: 'allow',
          at: 1,
        },
      ]);
      await store.upsertSessionMetadata({
        sessionId: snapshot.id,
        pinned: true,
      });
      await assert.rejects(
        store.deleteSession(snapshot.id),
        /injected delete failure/,
      );
      assert.ok(store.loadSnapshot(snapshot.id));
      assert.equal(store.listCheckpoints(snapshot.id).length, 1);
      assert.equal(store.listAudit(snapshot.id).length, 1);
      assert.ok(store.loadSessionMetadata(snapshot.id));
    },
    {
      failCheckpointDelete: 'injected delete failure',
    },
  );
});

test('saveCheckpoint + listCheckpoints preserve parent links and metadata', async () => {
  await withTempStore(async (store) => {
    const first: Checkpoint = {
      id: 'checkpoint-1',
      sessionId: 'session-1',
      createdAt: 1_000,
      runId: 'session-1-run-1',
      label: 'First run',
      summary: 'User asked for tasks.',
      snapshot: sampleSnapshot(),
      fileChanges: [{ path: 'README.md', status: 'modified' }],
    };
    const second: Checkpoint = {
      id: 'checkpoint-2',
      sessionId: 'session-1',
      parentCheckpointId: 'checkpoint-1',
      createdAt: 2_000,
      runId: 'session-1-run-2',
      label: 'Second run',
      summary: 'Assistant updated the answer.',
      snapshot: sampleSnapshot({
        history: [{ role: 'user', content: 'second' }],
      }),
    };

    await store.saveCheckpoint(first);
    await store.saveCheckpoint(second);
    await store.saveCheckpoint({
      ...first,
      id: 'checkpoint-other',
      sessionId: 'session-2',
      snapshot: sampleSnapshot({ id: 'session-2' }),
    });

    assert.deepEqual(
      store.listCheckpoints('session-1').map((checkpoint) => checkpoint.id),
      ['checkpoint-1', 'checkpoint-2'],
      'list is filtered by session and sorted by createdAt',
    );
    assert.deepEqual(
      store.loadCheckpoint('session-1', 'checkpoint-2'),
      second,
      'checkpoint JSON payload round-trips',
    );
    assert.equal(
      store.loadCheckpoint('session-1', 'checkpoint-other'),
      undefined,
      'checkpoint id must also match the requested session',
    );
  });
});

test('saveSnapshot upserts: second save keeps one row with the latest value', async () => {
  await withTempStore(async (store) => {
    await store.saveSnapshot(sampleSnapshot({ permissionMode: 'default' }));
    await store.saveSnapshot(
      sampleSnapshot({
        permissionMode: 'acceptEdits',
        history: [{ role: 'user', content: 'updated' }],
        todos: [],
      }),
    );

    const loaded = store.loadSnapshot('session-1');
    assert.equal(loaded?.permissionMode, 'acceptEdits', 'latest mode wins');
    assert.deepEqual(
      loaded?.history,
      [{ role: 'user', content: 'updated' }],
      'latest history wins',
    );
    assert.deepEqual(loaded?.todos, [], 'latest todos win');
  });
});

test('listSessions returns persisted snapshots newest first', async () => {
  await withTempStore(async (store) => {
    await store.saveSnapshot(sampleSnapshot({ id: 'older' }));
    await store.saveSnapshot(
      sampleSnapshot({ id: 'newer', cwd: '/work/newer' }),
    );

    const listed = store.listSessions();

    assert.deepEqual(
      listed.map((entry) => entry.snapshot.id),
      ['newer', 'older'],
      'sessions are sorted by updatedAt descending',
    );
    assert.equal(listed[0]?.snapshot.cwd, '/work/newer');
    assert.equal(typeof listed[0]?.updatedAt, 'number');
  });
});

test('appendAudit + listAudit returns entries in order, reason JSON round-trips', async () => {
  await withTempStore(async (store) => {
    const entries: PermissionAuditEntry[] = [
      {
        toolUseId: 'call-1',
        toolName: 'TaskList',
        behavior: 'allow',
        reason: { type: 'toolDefault' },
        at: 1000,
      },
      {
        toolUseId: 'call-2',
        toolName: 'Write',
        behavior: 'ask',
        reason: {
          type: 'rule',
          rule: { source: 'session', behavior: 'ask', toolName: 'Write' },
        },
        at: 2000,
      },
      {
        // No `reason` -> stored as NULL -> comes back without the key.
        toolUseId: 'call-3',
        toolName: 'Bash',
        behavior: 'deny',
        at: 3000,
      },
    ];

    await store.appendAudit('session-1', entries);

    const listed = store.listAudit('session-1');
    assert.deepEqual(listed, entries, 'audit round-trips in insertion order');

    // The second entry's structured reason survived JSON (de)serialization.
    const second = listed[1];
    assert.equal(
      second?.reason?.type === 'rule' && second.reason.rule.toolName,
      'Write',
      'nested reason JSON round-tripped',
    );
  });
});

test('listAudit is filtered by sessionId and preserves per-session order', async () => {
  await withTempStore(async (store) => {
    await store.appendAudit('session-a', [
      { toolUseId: 'a-1', toolName: 'TaskList', behavior: 'allow', at: 10 },
    ]);
    await store.appendAudit('session-b', [
      { toolUseId: 'b-1', toolName: 'Write', behavior: 'deny', at: 20 },
    ]);
    // A second batch for session-a appended after session-b's row exists.
    await store.appendAudit('session-a', [
      { toolUseId: 'a-2', toolName: 'Bash', behavior: 'ask', at: 30 },
    ]);

    const a = store.listAudit('session-a');
    assert.deepEqual(
      a.map((entry) => entry.toolUseId),
      ['a-1', 'a-2'],
      'only session-a entries, in insertion order',
    );

    const b = store.listAudit('session-b');
    assert.deepEqual(
      b.map((entry) => entry.toolUseId),
      ['b-1'],
      'only session-b entries',
    );

    assert.deepEqual(
      store.listAudit('session-c'),
      [],
      'an unknown session has an empty audit trail',
    );
  });
});

test('a reopened file DB still sees previously persisted data', async () => {
  const database = await createTestDatabase({ kind: 'migrated' });
  const dbPath = database.databasePath;
  try {
    const first = new SessionStore(database.provider);
    await first.saveSnapshot(sampleSnapshot({ id: 'persisted' }));
    await first.appendAudit('persisted', [
      { toolUseId: 'c-1', toolName: 'TaskList', behavior: 'allow', at: 99 },
    ]);
    first.close();
    await database.provider.close();

    // A brand-new store over the SAME file must observe the prior writes — the
    // the Provider must not mutate the migrated schema on reopen.
    const secondProvider = createTestDatabaseProvider(dbPath);
    const second = new SessionStore(secondProvider);
    try {
      assert.equal(second.loadSnapshot('persisted')?.id, 'persisted');
      assert.equal(second.listAudit('persisted').length, 1);
    } finally {
      second.close();
      await secondProvider.close();
    }
  } finally {
    await database.close();
  }
});

test('projects are imported idempotently by normalized path', async () => {
  await withTempStore(async (store) => {
    const first = await store.upsertProject('/work/project/');
    const second = await store.upsertProject('/work/project');

    assert.equal(second.id, first.id);
    assert.equal(second.path, '/work/project');
    assert.equal(second.name, 'project');
    assert.deepEqual(
      store.listProjects().map((project) => project.id),
      [first.id],
    );
  });
});

test('generated persistence timestamps use one injected database Clock value', async () => {
  const now = 1_700_000_000_123;
  await withTempStore(
    async (store) => {
      const project = await store.upsertProject('/work/clocked');
      await store.saveSnapshot(sampleSnapshot({ id: 'clocked-session' }));
      const listed = store
        .listSessions()
        .find((entry) => entry.snapshot.id === 'clocked-session');

      assert.equal(project.createdAt, now);
      assert.equal(project.updatedAt, now);
      assert.equal(listed?.updatedAt, now);
    },
    { clock: new TestDatabaseClock(now) },
  );
});

test('session metadata stores project scope and pinned state', async () => {
  await withTempStore(async (store) => {
    const project = await store.upsertProject('/work/project');
    await store.saveSnapshot(sampleSnapshot({ id: 'project-session' }));
    await store.upsertSessionMetadata({
      sessionId: 'project-session',
      projectId: project.id,
    });
    await store.setSessionPinned('project-session', true);

    const metadata = store.loadSessionMetadata('project-session');
    assert.equal(metadata?.projectId, project.id);
    assert.equal(metadata?.pinned, true);
  });
});

test('deleteSession hard-deletes snapshot, checkpoints, audit, and metadata', async () => {
  await withTempStore(async (store) => {
    const project = await store.upsertProject('/work/project');
    await store.saveSnapshot(sampleSnapshot({ id: 'session-delete' }));
    await store.upsertSessionMetadata({
      sessionId: 'session-delete',
      projectId: project.id,
    });
    await store.saveCheckpoint({
      id: 'checkpoint-delete',
      sessionId: 'session-delete',
      createdAt: 1,
      snapshot: sampleSnapshot({ id: 'session-delete' }),
    });
    await store.appendAudit('session-delete', [
      { toolUseId: 'call-delete', toolName: 'Read', behavior: 'allow', at: 1 },
    ]);

    assert.equal(await store.deleteSession('session-delete'), true);

    assert.equal(store.loadSnapshot('session-delete'), undefined);
    assert.deepEqual(store.listCheckpoints('session-delete'), []);
    assert.deepEqual(store.listAudit('session-delete'), []);
    assert.equal(store.loadSessionMetadata('session-delete'), undefined);
  });
});
