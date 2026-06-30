import { ToolRegistry } from '../core/registry.js';
import { ToolRunner } from '../core/runner.js';
import { ToolScheduler } from '../core/scheduler.js';
import {
  createRuntimeContext,
  type RuntimeContext,
  type RuntimeSubagentRequest,
  type RuntimeSubagentResult,
  type TodoItem,
  type Tool,
} from '../core/tool.js';
import type {
  ApprovalRequest,
  ApprovalResponse,
  PermissionAuditEntry,
  PermissionContext,
  PermissionMode,
} from '../core/permissions.js';
import type { CompactionConfig } from './compaction.js';
import type { ControlMessage } from './control.js';
import { contentToText } from './content.js';
import type { SessionEvent, SessionEventListener } from './events.js';
import type { ConversationEntry, ModelClient } from './model.js';
import { runTurn } from './turn.js';

// Dependencies injected when constructing or restoring a session. `tools` and
// `model` are required; everything else has a sensible default.
export type SessionDeps = {
  model: ModelClient;
  tools: Tool[];
  id?: string;
  cwd?: string;
  permissionContext?: PermissionContext;
  // The agent's system prompt. Supplied by the caller (the session engine is
  // prompt-agnostic; the server renders it from `@colorful-code/prompts`) and
  // forwarded to the model on every turn. Not part of the snapshot — it is
  // re-supplied via `restore`'s deps, like the model client and tools.
  systemPrompt?: string;
  // Optional automatic context-compaction policy (window/threshold/keep budget +
  // summarization prompt). Like the model and system prompt it is live wiring,
  // not snapshot data, so it is re-supplied on `restore`. Absent => no
  // compaction.
  compaction?: CompactionConfig;
  // Maximum nested Agent depth. The default allows a parent session to run one
  // child agent, while preventing recursive agent spawning unless explicitly
  // widened by the caller later.
  maxSubagentDepth?: number;
};

// The serializable shape persisted between sessions. It carries only data — no
// live handles (no AbortController, runner, model, or listeners). `restore`
// rebuilds the live machinery around it.
export type SessionSnapshot = {
  id: string;
  cwd?: string;
  history: ConversationEntry[];
  permissionMode: PermissionMode;
  workspaceRoots: string[];
  todos: TodoItem[];
};

function defaultPermissionContext(cwd?: string): PermissionContext {
  return {
    mode: 'default',
    workspaceRoots: cwd ? [cwd] : [],
    rules: [],
  };
}

let sessionCounter = 0;
function nextSessionId(): string {
  sessionCounter += 1;
  return 'session-' + String(sessionCounter);
}

// The product boundary: owns conversation history, the runtime context (todos,
// tasks, cwd, cancellation), the layered permission state, the tool registry +
// runner + scheduler, the injected model client, an event stream, and the
// pending-approval correlation map.
export class Session {
  readonly id: string;
  readonly cwd: string | undefined;
  readonly registry: ToolRegistry;
  readonly runner: ToolRunner;
  readonly scheduler: ToolScheduler;
  readonly context: RuntimeContext;
  readonly permissionContext: PermissionContext;

  private readonly model: ModelClient;
  private readonly systemPrompt: string | undefined;
  private readonly compaction: CompactionConfig | undefined;
  private readonly history: ConversationEntry[] = [];
  private readonly listeners = new Set<SessionEventListener>();
  // Maps a minted requestId to the resolver of its parked approval promise.
  private readonly pending = new Map<
    string,
    (response: ApprovalResponse) => void
  >();
  private abortController = new AbortController();
  private runCounter = 0;
  private requestCounter = 0;
  private subagentCounter = 0;
  private activeRun: Promise<void> | undefined;
  private activeRunId: string | undefined;

  constructor(deps: SessionDeps) {
    this.id = deps.id ?? nextSessionId();
    this.cwd = deps.cwd;
    this.permissionContext =
      deps.permissionContext ?? defaultPermissionContext(deps.cwd);

    this.registry = new ToolRegistry(deps.tools);
    this.model = deps.model;
    this.systemPrompt = deps.systemPrompt;
    this.compaction = deps.compaction;

    this.context = createRuntimeContext({
      ...(deps.cwd ? { cwd: deps.cwd } : {}),
      signal: this.abortController.signal,
      permissionContext: this.permissionContext,
      permissionAudit: [] as PermissionAuditEntry[],
      requestApproval: (request) => this.requestApproval(request),
      subagentDepth: 0,
      maxSubagentDepth: deps.maxSubagentDepth ?? 1,
      runSubagent: (request, context) => this.runSubagent(request, context),
    });

    this.runner = new ToolRunner(this.registry, this.context);
    this.scheduler = new ToolScheduler(this.runner);
  }

  // Registers an event listener; returns an unsubscribe function.
  subscribe(listener: SessionEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(event: SessionEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  // Mints a requestId, emits the correlated `approval_required` event, and parks
  // a promise whose resolver is stored under that id. A later
  // `approval_response` (or a `cancel`) resolves it.
  private requestApproval(request: ApprovalRequest): Promise<ApprovalResponse> {
    return new Promise<ApprovalResponse>((resolve) => {
      this.requestCounter += 1;
      const requestId = this.id + '-approval-' + String(this.requestCounter);
      this.pending.set(requestId, resolve);
      this.emit({
        type: 'approval_required',
        runId: this.activeRunId ?? this.id,
        requestId,
        toolUseId: request.toolUseId,
        name: request.toolName,
        input: request.input,
        message: request.message,
        ...(request.suggestions ? { suggestions: request.suggestions } : {}),
      });
    });
  }

  // Resolves a parked approval. Unknown ids are ignored (already answered or
  // cancelled).
  private resolveApproval(requestId: string, response: ApprovalResponse): void {
    const resolver = this.pending.get(requestId);
    if (!resolver) {
      return;
    }
    this.pending.delete(requestId);
    resolver(response);
  }

  // Auto-denies every parked approval. Used on `cancel` so a blocked turn can
  // unwind instead of hanging forever.
  private denyAllPending(message: string): void {
    for (const [requestId, resolver] of this.pending) {
      this.pending.delete(requestId);
      resolver({ behavior: 'deny', message });
    }
  }

  private async runSubagent(
    request: RuntimeSubagentRequest,
    parentContext: RuntimeContext,
  ): Promise<RuntimeSubagentResult> {
    this.subagentCounter += 1;
    const runId =
      (this.activeRunId ?? this.id) +
      '-subagent-' +
      String(this.subagentCounter);
    const signal =
      parentContext.signal ??
      this.context.signal ??
      this.abortController.signal;
    const childContext = createRuntimeContext({
      ...((parentContext.cwd ?? this.cwd)
        ? { cwd: parentContext.cwd ?? this.cwd }
        : {}),
      signal,
      permissionContext: this.permissionContext,
      permissionAudit: this.context.permissionAudit,
      requestApproval: (approval) => this.requestApproval(approval),
      permissionPolicy: parentContext.permissionPolicy,
      subagentDepth: (parentContext.subagentDepth ?? 0) + 1,
      maxSubagentDepth:
        parentContext.maxSubagentDepth ?? this.context.maxSubagentDepth ?? 1,
      runSubagent: (nestedRequest, nestedContext) =>
        this.runSubagent(nestedRequest, nestedContext),
      mcpManager: parentContext.mcpManager,
      mcpToolProvider: parentContext.mcpToolProvider,
      webFetchProvider: parentContext.webFetchProvider,
      webSearchProvider: parentContext.webSearchProvider,
      webBrowserProvider: parentContext.webBrowserProvider,
    });
    const runner = new ToolRunner(this.registry, childContext);
    const scheduler = new ToolScheduler(runner);
    const history: ConversationEntry[] = [
      { role: 'user', content: request.prompt },
    ];
    let finalOutput = '';
    let errorMessage = '';
    let terminalStatus:
      | Extract<SessionEvent, { type: 'run_status' }>['status']
      | undefined;

    await runTurn({
      runId,
      model: this.model,
      registry: this.registry,
      scheduler,
      context: childContext,
      history,
      signal,
      emit: (event) => {
        if (event.type === 'message') {
          finalOutput = contentToText(event.content);
        } else if (event.type === 'error') {
          errorMessage = event.message;
        } else if (event.type === 'run_status') {
          terminalStatus = event.status;
        }
      },
      ...(this.systemPrompt !== undefined
        ? { systemPrompt: this.systemPrompt }
        : {}),
      ...(this.compaction !== undefined ? { compaction: this.compaction } : {}),
    });

    if (signal.aborted || terminalStatus === 'cancelled') {
      throw new Error('Subagent was cancelled.');
    }
    if (terminalStatus === 'error') {
      throw new Error(errorMessage || 'Subagent failed.');
    }

    if (finalOutput.length === 0) {
      const lastAssistant = [...history]
        .reverse()
        .find((entry) => entry.role === 'assistant');
      finalOutput = lastAssistant ? contentToText(lastAssistant.content) : '';
    }

    return { status: 'completed', output: finalOutput };
  }

  // Appends a user message and runs a turn to completion. Concurrent submits are
  // serialized behind the active run.
  async submit(text: string): Promise<void> {
    if (this.activeRun) {
      await this.activeRun.catch(() => undefined);
    }

    this.history.push({ role: 'user', content: text });

    // A fresh AbortController per run so a prior cancellation does not poison the
    // next turn. The runtime context tracks the current signal.
    this.abortController = new AbortController();
    this.context.signal = this.abortController.signal;

    this.runCounter += 1;
    const runId = this.id + '-run-' + String(this.runCounter);
    this.activeRunId = runId;

    const run = runTurn({
      runId,
      model: this.model,
      registry: this.registry,
      scheduler: this.scheduler,
      context: this.context,
      history: this.history,
      signal: this.abortController.signal,
      emit: (event) => this.emit(event),
      ...(this.systemPrompt !== undefined
        ? { systemPrompt: this.systemPrompt }
        : {}),
      ...(this.compaction !== undefined ? { compaction: this.compaction } : {}),
    }).finally(() => {
      if (this.activeRunId === runId) {
        this.activeRunId = undefined;
        this.activeRun = undefined;
      }
    });
    this.activeRun = run;
    await run;
  }

  // Routes an inbound control message. `user_message` runs a turn in the
  // background (callers awaiting completion should use `submit`).
  send(message: ControlMessage): void {
    switch (message.type) {
      case 'user_message':
        void this.submit(message.text);
        return;
      case 'approval_response':
        this.resolveApproval(message.requestId, message.decision);
        return;
      case 'cancel':
        this.abortController.abort();
        this.denyAllPending('Run was cancelled.');
        return;
      case 'set_permission_mode':
        this.permissionContext.mode = message.mode;
        return;
    }
  }

  // A serializable view of the session: history + permission mode + todos. No
  // live handles cross this boundary.
  snapshot(): SessionSnapshot {
    return {
      id: this.id,
      ...(this.cwd ? { cwd: this.cwd } : {}),
      history: structuredClone(this.history),
      permissionMode: this.permissionContext.mode,
      workspaceRoots: [...this.permissionContext.workspaceRoots],
      todos: structuredClone(this.context.todos ?? []),
    };
  }

  // Rebuilds a live session around a snapshot. Tool implementations and the model
  // client cannot be serialized, so they are re-injected via `deps`.
  static restore(
    snapshot: SessionSnapshot,
    deps: {
      model: ModelClient;
      tools: Tool[];
      systemPrompt?: string;
      compaction?: CompactionConfig;
    },
  ): Session {
    const session = new Session({
      model: deps.model,
      tools: deps.tools,
      id: snapshot.id,
      ...(snapshot.cwd ? { cwd: snapshot.cwd } : {}),
      ...(deps.systemPrompt !== undefined
        ? { systemPrompt: deps.systemPrompt }
        : {}),
      ...(deps.compaction !== undefined ? { compaction: deps.compaction } : {}),
      permissionContext: {
        mode: snapshot.permissionMode,
        workspaceRoots: [...snapshot.workspaceRoots],
        rules: [],
      },
    });
    for (const entry of snapshot.history) {
      session.history.push(structuredClone(entry));
    }
    session.context.todos = structuredClone(snapshot.todos);
    return session;
  }
}
