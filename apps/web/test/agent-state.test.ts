import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  applyAgentEvent,
  composeMessageWithAttachments,
  composeVisibleMessageWithAttachments,
  conversationItemsFromHistory,
  createWorkspaceProject,
  createAgentViewState,
  hasGroupedHistory,
  selectedScopeForSession,
} from '../app/agent/state';
import type { SessionEvent, SessionSummary } from '../app/agent/types';

test('applyAgentEvent captures approval requests as actionable state', () => {
  const event: SessionEvent = {
    type: 'approval_required',
    runId: 'run-1',
    requestId: 'approval-1',
    toolUseId: 'tool-1',
    name: 'bash',
    input: { cmd: 'pnpm test' },
    message: 'Allow command?',
    source: { type: 'builtin' },
  };

  const state = applyAgentEvent(createAgentViewState(), event, 1);

  assert.equal(state.approval?.requestId, 'approval-1');
  assert.equal(state.approval?.name, 'bash');
  assert.deepEqual(state.approval?.input, { cmd: 'pnpm test' });
  assert.equal(state.log[0]?.event.type, 'approval_required');
});

test('applyAgentEvent updates edit proposal status without duplicating proposals', () => {
  const proposed: SessionEvent = {
    type: 'edit_proposed',
    runId: 'run-1',
    proposalId: 'proposal-1',
    toolUseId: 'tool-1',
    patches: [
      {
        path: 'apps/web/app/agent/page.tsx',
        status: 'modified',
        added: 1,
        removed: 1,
        hunks: [
          {
            oldStart: 1,
            oldLines: 1,
            newStart: 1,
            newLines: 1,
            lines: [
              { kind: 'removed', oldNumber: 1, text: 'old' },
              { kind: 'added', newNumber: 1, text: 'new' },
            ],
          },
        ],
      },
    ],
  };
  const applied: SessionEvent = {
    ...proposed,
    type: 'edit_applied',
  };

  const state = applyAgentEvent(
    applyAgentEvent(createAgentViewState(), proposed, 1),
    applied,
    2,
  );

  assert.equal(state.editProposals.length, 1);
  assert.equal(state.editProposals[0]?.status, 'applied');
  assert.equal(state.editProposals[0]?.seq, 2);
});

test('conversationItemsFromHistory restores transcript and tool results', () => {
  const items = conversationItemsFromHistory([
    { role: 'user', content: 'hello' },
    {
      role: 'assistant',
      content: [{ type: 'text', text: 'working' }],
      toolCalls: [
        {
          toolUseId: 'tool-1',
          name: 'Read',
          input: { file: 'README.md' },
        },
      ],
    },
    {
      role: 'tool',
      content: '',
      toolResults: [
        {
          toolUseId: 'tool-1',
          content: 'done',
          isError: false,
        },
      ],
    },
  ]);

  assert.deepEqual(items[0], { kind: 'user', text: 'hello' });
  assert.equal(items[1]?.kind, 'assistant');
  assert.equal(items[2]?.kind, 'tool');
  assert.equal(items[2]?.kind === 'tool' && items[2].result?.content, 'done');
});

test('createWorkspaceProject normalizes a picked workspace folder into a project', () => {
  const project = createWorkspaceProject(
    '  /Users/example/work/colorful-code/  ',
    3,
  );

  assert.equal(project.id, 'workspace-3');
  assert.equal(project.name, 'colorful-code');
  assert.equal(project.path, '/Users/example/work/colorful-code');
  assert.deepEqual(project.chats, []);
});

test('hasGroupedHistory is true for project-only or standalone history', () => {
  assert.equal(hasGroupedHistory([], []), false);
  assert.equal(
    hasGroupedHistory(
      [
        {
          id: 'project-1',
          name: 'Project',
          path: '/work/project',
          chats: [
            {
              id: 'session-1',
              title: 'Project chat',
              updatedAt: 1,
              pinned: false,
            },
          ],
        },
      ],
      [],
    ),
    true,
  );
  assert.equal(
    hasGroupedHistory(
      [],
      [
        {
          id: 'session-2',
          title: 'Standalone chat',
          updatedAt: 2,
          pinned: false,
        },
      ],
    ),
    true,
  );
});

test('selectedScopeForSession keeps new chat creation near restored history', () => {
  const projectChat: SessionSummary = {
    id: 'project-chat',
    title: 'Project chat',
    updatedAt: 1,
    pinned: false,
    projectId: 'project-1',
  };
  const standaloneChat: SessionSummary = {
    id: 'standalone-chat',
    title: 'Standalone chat',
    updatedAt: 2,
    pinned: false,
  };

  assert.deepEqual(
    selectedScopeForSession(projectChat),
    { type: 'project', projectId: 'project-1' },
  );
  assert.deepEqual(selectedScopeForSession(standaloneChat), { type: 'chats' });
});

test('composeMessageWithAttachments includes selected local files as agent context', () => {
  const message = composeMessageWithAttachments('Summarize this', [
    {
      name: 'notes.md',
      path: '/Users/example/notes.md',
    },
  ]);

  assert.match(message, /Summarize this/);
  assert.match(message, /Attached local files/);
  assert.match(message, /notes.md/);
  assert.match(message, /\/Users\/example\/notes\.md/);
});

test('composeVisibleMessageWithAttachments hides local file paths from the chat bubble', () => {
  const message = composeVisibleMessageWithAttachments('Summarize this', [
    {
      name: 'notes.md',
      path: '/Users/example/notes.md',
    },
  ]);

  assert.match(message, /Summarize this/);
  assert.match(message, /Attached files/);
  assert.match(message, /notes.md/);
  assert.doesNotMatch(message, /\/Users\/example\/notes\.md/);
});
