import { strict as assert } from 'node:assert';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type {
  Checkpoint,
  PermissionAuditEntry,
  SessionSnapshot,
} from '@colorful-code/tool-runtime';
import { SessionStore } from '../src/persistence/session-store';

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
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'colorful-code-store-'));
  // Nested under a not-yet-existing `data/` dir to exercise mkdir-recursive.
  const dbPath = join(dir, 'data', 'colorful-code.db');
  const store = SessionStore.openAt(dbPath);
  try {
    await body(store, dbPath);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
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
  await withTempStore((store, dbPath) => {
    const snapshot = sampleSnapshot();
    store.saveSnapshot(snapshot);

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

test('saveCheckpoint + listCheckpoints preserve parent links and metadata', async () => {
  await withTempStore((store) => {
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

    store.saveCheckpoint(first);
    store.saveCheckpoint(second);
    store.saveCheckpoint({
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
  await withTempStore((store) => {
    store.saveSnapshot(sampleSnapshot({ permissionMode: 'default' }));
    store.saveSnapshot(
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
  await withTempStore((store) => {
    store.saveSnapshot(sampleSnapshot({ id: 'older' }));
    store.saveSnapshot(sampleSnapshot({ id: 'newer', cwd: '/work/newer' }));

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
  await withTempStore((store) => {
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

    store.appendAudit('session-1', entries);

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
  await withTempStore((store) => {
    store.appendAudit('session-a', [
      { toolUseId: 'a-1', toolName: 'TaskList', behavior: 'allow', at: 10 },
    ]);
    store.appendAudit('session-b', [
      { toolUseId: 'b-1', toolName: 'Write', behavior: 'deny', at: 20 },
    ]);
    // A second batch for session-a appended after session-b's row exists.
    store.appendAudit('session-a', [
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
  const dir = mkdtempSync(join(tmpdir(), 'colorful-code-store-reopen-'));
  const dbPath = join(dir, 'data', 'colorful-code.db');
  try {
    const first = SessionStore.openAt(dbPath);
    first.saveSnapshot(sampleSnapshot({ id: 'persisted' }));
    first.appendAudit('persisted', [
      { toolUseId: 'c-1', toolName: 'TaskList', behavior: 'allow', at: 99 },
    ]);
    first.close();

    // A brand-new store over the SAME file must observe the prior writes — the
    // idempotent DDL must not wipe existing tables on reopen.
    const second = SessionStore.openAt(dbPath);
    try {
      assert.equal(second.loadSnapshot('persisted')?.id, 'persisted');
      assert.equal(second.listAudit('persisted').length, 1);
    } finally {
      second.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
