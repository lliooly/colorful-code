import type {
  Checkpoint,
  ConversationEntry,
  EditProposalStatus,
  FilePatch,
  JsonObject,
  LspServerStatus,
  McpServerStatus,
  MessageContent,
  RunStatus,
  SessionSummary,
  SessionEvent,
  ToolInvocationSource,
} from './types';

export type ConversationItem =
  | { kind: 'user'; text: string }
  | {
      kind: 'context_marker';
      id: string;
      status: 'started' | 'compacted' | 'skipped' | 'failed';
      tokensBefore?: number;
      tokensAfter?: number;
      entriesSummarized?: number;
      message?: string;
    }
  | {
      kind: 'assistant';
      runId: string;
      text: string;
      finalized: boolean;
      thinking: string;
    }
  | {
      kind: 'tool';
      toolUseId: string;
      name: string;
      input: JsonObject;
      source?: ToolInvocationSource;
      result?: {
        content: string;
        isError: boolean;
        source?: ToolInvocationSource;
      };
    };

export type ChatThread = {
  id: string;
  title: string;
  updatedAt: number;
  pinned?: boolean;
};

export type SelectedScope =
  | { type: 'chats' }
  | { type: 'project'; projectId: string };

export type WorkspaceProject = {
  id: string;
  name: string;
  path: string;
  createdAt?: number;
  updatedAt?: number;
  chats: SessionSummary[];
};

export type LocalFileAttachment = {
  name: string;
  path: string;
};

export type LoggedEvent = { seq: number; event: SessionEvent };

export type HookWarning = {
  seq: number;
  hookId: string;
  hookEvent: string;
  message: string;
  policy: string;
};

export type ApprovalState = {
  requestId: string;
  toolUseId: string;
  name: string;
  input: JsonObject;
  message: string;
  source?: ToolInvocationSource;
};

export type EditProposalRecord = {
  proposalId: string;
  runId: string;
  toolUseId?: string;
  patches: FilePatch[];
  status: EditProposalStatus;
  reason?: string;
  seq: number;
};

export type AgentViewState = {
  items: ConversationItem[];
  log: LoggedEvent[];
  hookWarnings: HookWarning[];
  approval: ApprovalState | null;
  editProposals: EditProposalRecord[];
  mcpServers: McpServerStatus[];
  lspServers: LspServerStatus[];
  runStatus: RunStatus | null;
  error: string | null;
  /** Latest input token count from the backend `usage` event. */
  contextTokens: number;
};

export function createAgentViewState(
  seedItems: ConversationItem[] = [],
): AgentViewState {
  return {
    items: seedItems,
    log: [],
    hookWarnings: [],
    approval: null,
    editProposals: [],
    mcpServers: [],
    lspServers: [],
    runStatus: null,
    error: null,
    contextTokens: 0,
  };
}

export function createWorkspaceProject(
  rawPath: string,
  ordinal: number,
): WorkspaceProject {
  const trimmed = rawPath.trim();
  const path = trimmed === '/' ? trimmed : trimmed.replace(/\/+$/, '');
  const segments = path.split('/').filter(Boolean);
  const fallbackName = `Workspace ${String(ordinal + 1)}`;
  return {
    id: `workspace-${String(ordinal)}`,
    name: segments.at(-1) ?? fallbackName,
    path,
    chats: [],
  };
}

export function hasGroupedHistory(
  projects: WorkspaceProject[],
  standaloneChats: SessionSummary[],
): boolean {
  return (
    standaloneChats.length > 0 ||
    projects.some((project) => project.chats.length > 0)
  );
}

export function selectedScopeForSession(
  summary: Pick<SessionSummary, 'projectId'>,
): SelectedScope {
  return summary.projectId
    ? { type: 'project', projectId: summary.projectId }
    : { type: 'chats' };
}

export function composeMessageWithAttachments(
  text: string,
  attachments: LocalFileAttachment[],
): string {
  const trimmed = text.trim();
  if (attachments.length === 0) return trimmed;

  const attachmentLines = attachments.map(
    (attachment) => `- ${attachment.name}: ${attachment.path}`,
  );

  const prefix = trimmed.length > 0 ? [trimmed, ''] : [];
  return [
    ...prefix,
    'Attached local files:',
    ...attachmentLines,
    '',
    'Use the file paths above when you need to inspect the uploaded files.',
  ].join('\n');
}

export function composeVisibleMessageWithAttachments(
  text: string,
  attachments: LocalFileAttachment[],
): string {
  const trimmed = text.trim();
  if (attachments.length === 0) return trimmed;

  const attachmentLines = attachments.map(
    (attachment) => `- ${attachment.name}`,
  );
  const prefix = trimmed.length > 0 ? [trimmed, ''] : [];
  return [...prefix, 'Attached files:', ...attachmentLines].join('\n');
}

export function applyAgentEvent(
  state: AgentViewState,
  event: SessionEvent,
  seq: number,
): AgentViewState {
  const next: AgentViewState = {
    ...state,
    log: [...state.log, { seq, event }],
  };

  switch (event.type) {
    case 'mcp_status':
      return { ...next, mcpServers: event.servers };
    case 'lsp_status':
      return { ...next, lspServers: event.servers };
    case 'run_status':
      return { ...next, runStatus: event.status };
    case 'message_delta':
      return {
        ...next,
        items: appendDelta(next.items, event.runId, event.text),
      };
    case 'thinking_delta':
      return {
        ...next,
        items: appendThinking(next.items, event.runId, event.text),
      };
    case 'message':
      return {
        ...next,
        items: finalizeMessage(next.items, event.runId, event.content),
      };
    case 'tool_call':
      return {
        ...next,
        items: [
          ...next.items,
          {
            kind: 'tool',
            toolUseId: event.toolUseId,
            name: event.name,
            input: event.input,
            ...(event.source ? { source: event.source } : {}),
          },
        ],
      };
    case 'tool_result':
      return {
        ...next,
        items: attachResult(next.items, event.toolUseId, {
          content: event.content,
          isError: event.isError ?? false,
          ...(event.source ? { source: event.source } : {}),
        }),
      };
    case 'approval_required':
      return {
        ...next,
        approval: {
          requestId: event.requestId,
          toolUseId: event.toolUseId,
          name: event.name,
          input: event.input,
          message: event.message,
          ...(event.source ? { source: event.source } : {}),
        },
      };
    case 'hook_failure':
      return {
        ...next,
        hookWarnings: [
          ...next.hookWarnings.slice(-4),
          {
            seq,
            hookId: event.hookId,
            hookEvent: event.hookEvent,
            message: event.message,
            policy: event.policy,
          },
        ],
      };
    case 'edit_proposed':
    case 'edit_approved':
    case 'edit_applied':
    case 'edit_rejected':
    case 'edit_conflict':
      return {
        ...next,
        editProposals: upsertEditProposal(
          next.editProposals,
          {
            proposalId: event.proposalId,
            runId: event.runId,
            ...(event.toolUseId ? { toolUseId: event.toolUseId } : {}),
            patches: event.patches,
            status: editStatusFromEvent(event.type),
            ...('reason' in event && event.reason
              ? { reason: event.reason }
              : {}),
          },
          seq,
        ),
      };
    case 'usage':
      return {
        ...next,
        contextTokens: event.inputTokens ?? next.contextTokens,
      };
    case 'context_compaction_started':
      return {
        ...next,
        items: [
          ...next.items,
          {
            kind: 'context_marker',
            id: `${event.runId}-started`,
            status: 'started',
          },
        ],
      };
    case 'context_compacted':
      return {
        ...next,
        items: [
          ...next.items,
          {
            kind: 'context_marker',
            id: `${event.runId}-compacted`,
            status: 'compacted',
            tokensBefore: event.tokensBefore,
            tokensAfter: event.tokensAfter,
            entriesSummarized: event.entriesSummarized,
          },
        ],
        contextTokens: event.tokensAfter,
      };
    case 'context_compaction_skipped':
      return {
        ...next,
        items: [
          ...next.items,
          {
            kind: 'context_marker',
            id: `${event.runId}-skipped`,
            status: 'skipped',
            message: event.reason,
          },
        ],
      };
    case 'context_compaction_failed':
      return {
        ...next,
        items: [
          ...next.items,
          {
            kind: 'context_marker',
            id: `${event.runId}-failed`,
            status: 'failed',
            message: event.message,
          },
        ],
      };
    case 'error':
      return { ...next, error: event.message };
    default:
      return next;
  }
}

export function appendDelta(
  items: ConversationItem[],
  runId: string,
  text: string,
): ConversationItem[] {
  const last = items[items.length - 1];
  if (
    last &&
    last.kind === 'assistant' &&
    last.runId === runId &&
    !last.finalized
  ) {
    return [...items.slice(0, -1), { ...last, text: last.text + text }];
  }
  return [
    ...items,
    { kind: 'assistant', runId, text, finalized: false, thinking: '' },
  ];
}

export function appendThinking(
  items: ConversationItem[],
  runId: string,
  text: string,
): ConversationItem[] {
  const last = items[items.length - 1];
  if (
    last &&
    last.kind === 'assistant' &&
    last.runId === runId &&
    !last.finalized
  ) {
    return [...items.slice(0, -1), { ...last, thinking: last.thinking + text }];
  }
  return [
    ...items,
    { kind: 'assistant', runId, text: '', finalized: false, thinking: text },
  ];
}

export function finalizeMessage(
  items: ConversationItem[],
  runId: string,
  content: string,
): ConversationItem[] {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (item.kind === 'assistant' && item.runId === runId && !item.finalized) {
      return [
        ...items.slice(0, i),
        { ...item, text: content, finalized: true },
        ...items.slice(i + 1),
      ];
    }
  }
  return [
    ...items,
    { kind: 'assistant', runId, text: content, finalized: true, thinking: '' },
  ];
}

export function attachResult(
  items: ConversationItem[],
  toolUseId: string,
  result: { content: string; isError: boolean; source?: ToolInvocationSource },
): ConversationItem[] {
  return items.map((item) =>
    item.kind === 'tool' && item.toolUseId === toolUseId
      ? { ...item, result }
      : item,
  );
}

export function upsertEditProposal(
  items: EditProposalRecord[],
  proposal: Omit<EditProposalRecord, 'seq'>,
  seq: number,
): EditProposalRecord[] {
  const next: EditProposalRecord = { ...proposal, seq };
  const index = items.findIndex(
    (item) => item.proposalId === proposal.proposalId,
  );
  if (index === -1) return [...items, next];
  const existing = items[index];
  const merged: EditProposalRecord = {
    ...existing,
    ...next,
    reason: proposal.reason ?? existing.reason,
  };
  return [...items.slice(0, index), merged, ...items.slice(index + 1)];
}

export function conversationItemsFromHistory(
  history: ConversationEntry[],
): ConversationItem[] {
  const items: ConversationItem[] = [];
  history.forEach((entry, index) => {
    const text = messageContentToText(entry.content);
    if (entry.role === 'user') {
      if (text) items.push({ kind: 'user', text });
      return;
    }
    if (entry.role === 'assistant') {
      if (text) {
        items.push({
          kind: 'assistant',
          runId: `checkpoint-${String(index)}`,
          text,
          finalized: true,
          thinking: '',
        });
      }
      for (const call of entry.toolCalls ?? []) {
        items.push({
          kind: 'tool',
          toolUseId: call.toolUseId,
          name: call.name,
          input: call.input,
        });
      }
      return;
    }
    for (const result of entry.toolResults ?? []) {
      const toolResult = {
        content: result.content,
        isError: result.isError ?? false,
      };
      const lastIndex = findToolItemIndex(items, result.toolUseId);
      if (lastIndex >= 0) {
        const toolItem = items[lastIndex];
        if (toolItem?.kind === 'tool') {
          items[lastIndex] = { ...toolItem, result: toolResult };
        }
      } else {
        items.push({
          kind: 'tool',
          toolUseId: result.toolUseId,
          name: result.toolUseId,
          input: {},
          result: toolResult,
        });
      }
    }
  });
  return items;
}

export function messageContentToText(content: MessageContent): string {
  if (typeof content === 'string') return content;
  return content
    .map((block) =>
      block.type === 'text' ? block.text : `[image: ${block.mediaType}]`,
    )
    .join('\n');
}

export function sortedEditProposals(
  editProposals: EditProposalRecord[],
): EditProposalRecord[] {
  return [...editProposals].sort((a, b) => b.seq - a.seq);
}

export function formatCheckpointTime(value: number): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString();
}

export function patchCounts(patch: FilePatch): {
  added: number;
  removed: number;
} {
  return patch.hunks.reduce(
    (acc, hunk) => ({
      added:
        acc.added + hunk.lines.filter((line) => line.kind === 'added').length,
      removed:
        acc.removed +
        hunk.lines.filter((line) => line.kind === 'removed').length,
    }),
    { added: 0, removed: 0 },
  );
}

export function patchStatusLabel(status: FilePatch['status']): string {
  switch (status) {
    case 'added':
      return 'added';
    case 'deleted':
      return 'deleted';
    default:
      return 'modified';
  }
}

export function formatToolSourceLabel(
  source: ToolInvocationSource | undefined,
): string | null {
  if (!source) return null;
  if (source.type === 'mcp') return `mcp:${source.server}`;
  if (source.type === 'lsp') return 'lsp';
  return null;
}

export function checkpointsToChats(checkpoints: Checkpoint[]): Array<{
  id: string;
  title: string;
  updatedAt: string;
}> {
  return checkpoints
    .slice()
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((checkpoint, index) => ({
      id: checkpoint.id,
      title:
        checkpoint.label ??
        checkpoint.summary ??
        `Checkpoint ${String(checkpoints.length - index)}`,
      updatedAt: formatCheckpointTime(checkpoint.createdAt),
    }));
}

function editStatusFromEvent(type: SessionEvent['type']): EditProposalStatus {
  switch (type) {
    case 'edit_approved':
      return 'approved';
    case 'edit_applied':
      return 'applied';
    case 'edit_rejected':
      return 'rejected';
    case 'edit_conflict':
      return 'conflict';
    default:
      return 'proposed';
  }
}

function findToolItemIndex(
  items: ConversationItem[],
  toolUseId: string,
): number {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (item?.kind === 'tool' && item.toolUseId === toolUseId) {
      return i;
    }
  }
  return -1;
}
