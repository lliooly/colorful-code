import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildSystemPrompt,
  createDefaultDynamicSections,
  STATIC_SYSTEM_PROMPT_SECTIONS,
} from '@colorful-code/prompts';
import type {
  ModelClient,
  ModelTurnInput,
  ModelTurnEvent,
} from '@colorful-code/tool-runtime';
import type {
  PermissionAuditEntry,
  SessionSnapshot,
} from '@colorful-code/tool-runtime';
import type { SessionStore } from '../src/persistence/session-store';
import { SessionsService } from '../src/sessions/sessions.service';
import type { ModelClientFactory } from '../src/sessions/model-factory';

async function waitFor(
  predicate: () => boolean,
  label: string,
  attempts = 50,
): Promise<void> {
  for (let index = 0; index < attempts; index += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.fail(`timed out waiting for: ${label}`);
}

function createMemoryStore(): SessionStore {
  const snapshots = new Map<string, SessionSnapshot>();
  const audit = new Map<string, PermissionAuditEntry[]>();

  return {
    saveSnapshot(snapshot: SessionSnapshot): void {
      snapshots.set(snapshot.id, snapshot);
    },
    loadSnapshot(id: string): SessionSnapshot | undefined {
      return snapshots.get(id);
    },
    appendAudit(sessionId: string, entries: PermissionAuditEntry[]): void {
      audit.set(sessionId, [...(audit.get(sessionId) ?? []), ...entries]);
    },
    listAudit(sessionId: string): PermissionAuditEntry[] {
      return [...(audit.get(sessionId) ?? [])];
    },
    close(): void {},
    onModuleDestroy(): void {},
  } as SessionStore;
}

function sampleSnapshot(
  overrides: Partial<SessionSnapshot> = {},
): SessionSnapshot {
  return {
    id: 'session-1',
    cwd: '/workspace/app',
    history: [{ role: 'user', content: 'hello' }],
    permissionMode: 'default',
    workspaceRoots: ['/workspace/app'],
    todos: [],
    ...overrides,
  };
}

test('default dynamic prompt sections omit TODO placeholders when context is absent', async () => {
  const prompt = await buildSystemPrompt({
    staticSections: [],
    dynamicSections: createDefaultDynamicSections(),
    sectionContext: {},
  });

  assert.equal(prompt.join('\n\n').includes('TODO'), false);
});

test('default static prompt asks the model to follow the user message language', () => {
  assert.match(
    STATIC_SYSTEM_PROMPT_SECTIONS.join('\n\n'),
    /Respond in the same language as the user's latest message\./,
  );
});

test('create session options feed permission state and dynamic context into the model system prompt', async () => {
  const seen: ModelTurnInput[] = [];
  const capturingFactory: ModelClientFactory = (): ModelClient => ({
    run(input: ModelTurnInput): AsyncIterable<ModelTurnEvent> {
      seen.push(input);
      return (async function* () {
        yield { type: 'end' as const };
      })();
    },
  });
  const store = createMemoryStore();
  const service = new SessionsService(capturingFactory, store);

  const { id } = await service.create({
    cwd: '/workspace/app',
    workspaceRoots: ['/workspace/app', '/workspace/shared'],
    permissionMode: 'readOnly',
  });

  try {
    service.submit(id, 'hello');
    await waitFor(() => seen.length === 1, 'model turn input');
    await waitFor(
      () => service.loadSnapshot(id) !== undefined,
      'persisted completed snapshot',
    );

    const system = seen[0]?.system ?? '';
    assert.match(system, /# Environment/);
    assert.match(system, /cwd: \/workspace\/app/);
    assert.match(
      system,
      /workspaceRoots:\n- \/workspace\/app\n- \/workspace\/shared/,
    );
    assert.match(system, /permissionMode: readOnly/);
    assert.match(system, /currentDateTime:/);
    assert.equal(system.includes('TODO'), false);

    const snapshot = service.loadSnapshot(id);
    assert.equal(snapshot?.cwd, '/workspace/app');
    assert.deepEqual(snapshot?.workspaceRoots, [
      '/workspace/app',
      '/workspace/shared',
    ]);
    assert.equal(snapshot?.permissionMode, 'readOnly');
  } finally {
    await service.dispose(id);
  }
});

test('create session loads CLAUDE.md from the workspace into project memory', async () => {
  const root = mkdtempSync(join(tmpdir(), 'colorful-code-memory-'));
  const cwd = join(root, 'packages', 'app');
  mkdirSync(cwd, { recursive: true });
  writeFileSync(
    join(root, 'CLAUDE.md'),
    'Always prefer the project memory test instruction.',
    'utf8',
  );

  const seen: ModelTurnInput[] = [];
  const capturingFactory: ModelClientFactory = (): ModelClient => ({
    run(input: ModelTurnInput): AsyncIterable<ModelTurnEvent> {
      seen.push(input);
      return (async function* () {
        yield { type: 'end' as const };
      })();
    },
  });
  const store = createMemoryStore();
  const service = new SessionsService(capturingFactory, store);

  const { id } = await service.create({
    cwd,
    workspaceRoots: [root],
  });

  try {
    service.submit(id, 'hello');
    await waitFor(() => seen.length === 1, 'model turn input');

    const system = seen[0]?.system ?? '';
    assert.match(system, /# Memory/);
    assert.match(system, /Always prefer the project memory test instruction\./);
    assert.match(system, /CLAUDE\.md/);
  } finally {
    await service.dispose(id);
    rmSync(root, { recursive: true, force: true });
  }
});

test('startup preload restores only sessions updated in the last three days', async () => {
  const now = Date.now();
  const recent = sampleSnapshot({ id: 'recent-session' });
  const stale = sampleSnapshot({ id: 'stale-session' });
  const snapshots = new Map([
    [recent.id, recent],
    [stale.id, stale],
  ]);
  const store = {
    loadSnapshot(id: string): SessionSnapshot | undefined {
      return snapshots.get(id);
    },
    listSessions(): Array<{ snapshot: SessionSnapshot; updatedAt: number }> {
      return [
        { snapshot: recent, updatedAt: now - 2 * 24 * 60 * 60 * 1000 },
        { snapshot: stale, updatedAt: now - 4 * 24 * 60 * 60 * 1000 },
      ];
    },
    listCheckpoints(): [] {
      return [];
    },
    loadSessionMetadata(): undefined {
      return undefined;
    },
    close(): void {},
    onModuleDestroy(): void {},
  } as unknown as SessionStore;
  const service = new SessionsService(
    (): ModelClient => ({
      run(): AsyncIterable<ModelTurnEvent> {
        return (async function* () {
          yield { type: 'end' as const };
        })();
      },
    }),
    store,
  );

  service.onModuleInit();
  await waitFor(() => service.has('recent-session'), 'recent session preload');

  assert.equal(service.has('recent-session'), true);
  assert.equal(service.has('stale-session'), false);

  await service.dispose('recent-session');
});
