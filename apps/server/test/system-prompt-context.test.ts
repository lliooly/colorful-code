import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildSystemPrompt,
  createDefaultDynamicSections,
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

test('default dynamic prompt sections omit TODO placeholders when context is absent', async () => {
  const prompt = await buildSystemPrompt({
    staticSections: [],
    dynamicSections: createDefaultDynamicSections(),
    sectionContext: {},
  });

  assert.equal(prompt.join('\n\n').includes('TODO'), false);
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

  const { id } = service.create({
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
    service.dispose(id);
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

  const { id } = service.create({
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
    service.dispose(id);
    rmSync(root, { recursive: true, force: true });
  }
});
