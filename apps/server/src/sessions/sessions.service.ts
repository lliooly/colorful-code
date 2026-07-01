import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  OnModuleDestroy,
} from '@nestjs/common';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Observable } from 'rxjs';
import {
  createBuiltinTools,
  createMcpRuntimeTools,
  SdkMcpManager,
  Session,
  buildMcpToolName,
  contentToText,
  normalizeMcpName,
  type Checkpoint,
  type ControlMessage,
  type ConversationEntry,
  type McpManager,
  type McpServerConnection,
  type PermissionAuditEntry,
  type PermissionContext,
  type PermissionMode,
  type PermissionRule,
  type SessionEvent,
  type McpServerStatus,
  type SessionSnapshot,
} from '@colorful-code/tool-runtime';
import {
  buildSystemPromptSync,
  createDefaultDynamicSections,
  STATIC_SYSTEM_PROMPT_SECTIONS,
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
} from '@colorful-code/prompts';
import {
  MODEL_CLIENT_FACTORY,
  ModelSelectionError,
  type ModelClientFactory,
  type ModelSelection,
} from './model-factory';
import { buildCompactionConfig } from './compaction-config';
import { SessionStore } from '../persistence/session-store';
import {
  loadMcpServersFromEnv,
  loadProjectMcpServers,
  mergeMcpServers,
  type McpServersConfig,
} from '../config/mcp-config';

// Options accepted by `POST /sessions` to seed a session's PermissionContext and
// (optionally) choose the model. `model` is the validated per-request selection;
// absent means the server default. The apiKey inside a selection (custom BYO
// path) is forwarded to the factory and never stored on the session.
export type CreateSessionOptions = {
  permissionMode?: PermissionMode;
  workspaceRoots?: string[];
  rules?: PermissionRule[];
  cwd?: string;
  model?: ModelSelection;
  mcpServers?: McpServersConfig;
};

export type RestoreSessionOptions = {
  model?: ModelSelection;
  mcpServers?: McpServersConfig;
};

// What the service tracks per live session: the engine `Session`, an append-only
// log of every emitted `SessionEvent` (the replay buffer), the live listener set,
// and the unsubscribe handle for the engine subscription. The log is what lets a
// subscriber that connects *after* `submit` still observe `running` /
// `approval_required`.
type SessionEntry = {
  session: Session;
  log: SessionEvent[];
  listeners: Set<(event: SessionEvent) => void>;
  unsubscribe: () => void;
  mcpManager?: McpManager;
  currentCheckpointId?: string;
  // Permission-audit entries observed since the last persistence flush. Drained
  // into the append-only audit table when a run reaches a terminal status (and
  // on dispose) so the table never holds duplicates of an already-flushed entry.
  pendingAudit: PermissionAuditEntry[];
};

type PreparedSession = {
  session: Session;
  mcpManager?: McpManager;
  mcpConnections: McpServerConnection[];
};

const PROJECT_MEMORY_FILE = 'CLAUDE.md';
const PROJECT_MEMORY_MAX_CHARS = 64_000;

function isWithinOrEqual(parent: string, child: string): boolean {
  return (
    child === parent ||
    child.startsWith(parent.endsWith('/') ? parent : parent + '/')
  );
}

function findWorkspaceMemoryDirs(
  cwd: string,
  workspaceRoots: string[],
): string[] {
  const resolvedCwd = resolve(cwd);
  const roots = workspaceRoots.map((root) => resolve(root));
  const boundary =
    roots
      .filter((root) => isWithinOrEqual(root, resolvedCwd))
      .sort((a, b) => b.length - a.length)[0] ?? resolvedCwd;

  const dirs: string[] = [];
  for (let dir = resolvedCwd; ; dir = dirname(dir)) {
    dirs.push(dir);
    if (dir === boundary || dir === dirname(dir)) {
      break;
    }
  }
  return dirs.reverse();
}

function readProjectMemory(
  cwd: string | undefined,
  workspaceRoots: string[],
): string | null {
  if (!cwd) {
    return null;
  }

  const sections: string[] = [];
  for (const dir of findWorkspaceMemoryDirs(cwd, workspaceRoots)) {
    const file = join(dir, PROJECT_MEMORY_FILE);
    try {
      if (!existsSync(file) || !statSync(file).isFile()) {
        continue;
      }
      const content = readFileSync(file, 'utf8').trim();
      if (content.length === 0) {
        continue;
      }
      sections.push(
        PROJECT_MEMORY_FILE +
          ': ' +
          file +
          '\n' +
          content.slice(0, PROJECT_MEMORY_MAX_CHARS),
      );
    } catch {
      // Project memory is advisory context. A transient filesystem issue should
      // not make session creation fail.
    }
  }

  return sections.length > 0 ? sections.join('\n\n') : null;
}

// Renders the agent prompt for one session. Static identity/safety/behaviour
// sections stay unchanged; the dynamic tail records runtime context that the
// model otherwise cannot infer from conversation history.
function buildSessionSystemPrompt(
  options: CreateSessionOptions,
  permissionContext: PermissionContext,
): string {
  const prompt = buildSystemPromptSync({
    staticSections: STATIC_SYSTEM_PROMPT_SECTIONS,
    dynamicSections: createDefaultDynamicSections(),
    sectionContext: {
      now: new Date(),
      ...(options.cwd ? { cwd: options.cwd } : {}),
      workspaceRoots: [...permissionContext.workspaceRoots],
      permissionMode: permissionContext.mode,
      memorySummary: readProjectMemory(
        options.cwd,
        permissionContext.workspaceRoots,
      ),
    },
  });

  return prompt
    .filter((section) => section !== SYSTEM_PROMPT_DYNAMIC_BOUNDARY)
    .join('\n\n');
}

// Run statuses that mark a turn finished; a terminal status triggers a snapshot
// save + audit flush.
const TERMINAL_RUN_STATUSES: ReadonlySet<string> = new Set([
  'completed',
  'cancelled',
  'error',
]);

@Injectable()
export class SessionsService implements OnModuleDestroy {
  private readonly entries = new Map<string, SessionEntry>();
  private sessionOrdinal = 0;
  private checkpointOrdinal = 0;

  constructor(
    @Inject(MODEL_CLIENT_FACTORY)
    private readonly modelClientFactory: ModelClientFactory,
    private readonly store: SessionStore,
  ) {}

  // Builds a fresh PermissionContext from the request options. `workspaceRoots`
  // falls back to `[cwd]` when a cwd is supplied (mirrors the engine default).
  private buildPermissionContext(
    options: CreateSessionOptions,
    mcpServers: McpServersConfig,
  ): PermissionContext {
    const workspaceRoots =
      options.workspaceRoots ?? (options.cwd ? [options.cwd] : []);
    const mcpTrust = this.buildMcpTrust(mcpServers);
    return {
      mode: options.permissionMode ?? 'default',
      workspaceRoots: [...workspaceRoots],
      rules: options.rules ? [...options.rules] : [],
      ...(mcpTrust.size > 0 ? { mcpTrust } : {}),
    };
  }

  private buildRestoredPermissionContext(
    snapshot: SessionSnapshot,
    mcpServers: McpServersConfig,
  ): PermissionContext {
    const mcpTrust = this.buildMcpTrust(mcpServers);
    return {
      mode: snapshot.permissionMode,
      workspaceRoots: [...snapshot.workspaceRoots],
      rules: [],
      ...(mcpTrust.size > 0 ? { mcpTrust } : {}),
    };
  }

  private buildMcpTrust(
    mcpServers: McpServersConfig,
  ): Map<string, 'trusted' | 'ask' | 'blocked'> {
    const trust = new Map<string, 'trusted' | 'ask' | 'blocked'>();
    for (const [name, config] of Object.entries(mcpServers)) {
      const level = config.trust ?? 'ask';
      trust.set(name, level);
      trust.set(normalizeMcpName(name), level);
    }
    return trust;
  }

  private toMcpServerStatus(connection: McpServerConnection): McpServerStatus {
    const transport = connection.config.type ?? 'stdio';
    if (connection.type === 'failed') {
      return {
        name: connection.name,
        status: 'failed',
        transport,
        tools: [],
        resources: [],
        error: connection.error,
      };
    }
    return {
      name: connection.name,
      status: 'connected',
      transport,
      tools: connection.tools.map((tool) => ({
        name: tool.name,
        registeredName: buildMcpToolName(connection.name, tool.name),
        ...(tool.description ? { description: tool.description } : {}),
      })),
      resources: connection.resources.map((resource) => ({
        uri: resource.uri,
        ...(resource.name ? { name: resource.name } : {}),
        ...(resource.mimeType ? { mimeType: resource.mimeType } : {}),
        ...(resource.description ? { description: resource.description } : {}),
      })),
      ...(connection.instructions
        ? { instructions: connection.instructions }
        : {}),
    };
  }

  private resolveMcpServers(
    cwd: string | undefined,
    requestMcpServers: McpServersConfig | undefined,
  ): McpServersConfig {
    try {
      return mergeMcpServers(
        loadProjectMcpServers(cwd),
        loadMcpServersFromEnv(process.env),
        requestMcpServers,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new BadRequestException(message);
    }
  }

  private async buildToolsAndMcp(mcpServers: McpServersConfig): Promise<{
    tools: ReturnType<typeof createBuiltinTools>;
    mcpManager?: McpManager;
    mcpConnections: McpServerConnection[];
  }> {
    if (Object.keys(mcpServers).length === 0) {
      return { tools: createBuiltinTools(), mcpConnections: [] };
    }

    const manager = new SdkMcpManager(mcpServers);
    const mcpTools = await createMcpRuntimeTools(manager);
    const mcpBuiltinNames = new Set([
      'MCPTool',
      'McpAuth',
      'ListMcpResourcesTool',
      'ReadMcpResourceTool',
    ]);
    const builtinTools = createBuiltinTools().filter(
      (tool) => !mcpBuiltinNames.has(tool.name),
    );
    const mcpConnections = await manager.connectAll();
    return {
      tools: [...builtinTools, ...mcpTools],
      mcpManager: manager,
      mcpConnections,
    };
  }

  private buildModelClient(id: string, selection?: ModelSelection) {
    try {
      return this.modelClientFactory({
        sessionId: id,
        ...(selection ? { selection } : {}),
      });
    } catch (error) {
      if (error instanceof ModelSelectionError) {
        throw new BadRequestException(error.message);
      }
      throw error;
    }
  }

  private nextSessionId(): string {
    this.sessionOrdinal += 1;
    return `session-${String(Date.now())}-${String(this.sessionOrdinal)}`;
  }

  private nextCheckpointId(sessionId: string): string {
    this.checkpointOrdinal += 1;
    return `checkpoint-${sessionId}-${String(Date.now())}-${String(
      this.checkpointOrdinal,
    )}`;
  }

  // Wires a live session to the replay buffer + live listeners and registers it.
  // Both create and restore use this so restored sessions persist, stream, and
  // dispose exactly like freshly created ones.
  private register(
    session: Session,
    options: {
      mcpManager?: McpManager;
      mcpConnections?: McpServerConnection[];
      currentCheckpointId?: string;
    } = {},
  ): { id: string } {
    const log: SessionEvent[] = [];
    const listeners = new Set<(event: SessionEvent) => void>();
    const pendingAudit: PermissionAuditEntry[] = [];
    const entry: SessionEntry = {
      session,
      log,
      listeners,
      unsubscribe: () => undefined,
      pendingAudit,
      ...(options.currentCheckpointId
        ? { currentCheckpointId: options.currentCheckpointId }
        : {}),
      ...(options.mcpManager ? { mcpManager: options.mcpManager } : {}),
    };

    entry.unsubscribe = session.subscribe((event) => {
      // Buffer first (so late subscribers replay it), then fan out live.
      log.push(event);
      for (const listener of listeners) {
        listener(event);
      }
      // Persistence taps the same stream: collect audit entries as they arrive,
      // and flush a snapshot + the buffered audit whenever a run terminates.
      if (event.type === 'permission_decision') {
        pendingAudit.push(event.entry);
      } else if (
        event.type === 'run_status' &&
        TERMINAL_RUN_STATUSES.has(event.status)
      ) {
        this.persist(session, pendingAudit);
        this.saveRunCheckpoint(entry, event);
      }
    });

    if (options.mcpConnections && options.mcpConnections.length > 0) {
      log.push({
        type: 'mcp_status',
        servers: options.mcpConnections.map((connection) =>
          this.toMcpServerStatus(connection),
        ),
      });
    }

    this.entries.set(session.id, entry);
    return { id: session.id };
  }

  // Creates a session, wires its event subscription to the replay buffer + live
  // listeners, and registers it. The model client is built per session via the
  // injected factory; tools are the built-ins.
  async create(options: CreateSessionOptions = {}): Promise<{ id: string }> {
    const mcpServers = this.resolveMcpServers(options.cwd, options.mcpServers);
    const permissionContext = this.buildPermissionContext(options, mcpServers);

    // Mint the id up front so the factory can key on it if needed.
    const id = this.nextSessionId();

    // Build the model client now so a bad selection (missing provider key,
    // incomplete custom config) fails the create request with a 400 rather than
    // surfacing mid-turn. The apiKey lives only inside the built client.
    const model = this.buildModelClient(id, options.model);
    const { tools, mcpManager, mcpConnections } =
      await this.buildToolsAndMcp(mcpServers);

    return this.register(
      new Session({
        id,
        model,
        tools,
        systemPrompt: buildSessionSystemPrompt(options, permissionContext),
        compaction: buildCompactionConfig(options.model),
        ...(options.cwd ? { cwd: options.cwd } : {}),
        permissionContext,
        ...(mcpManager ? { mcpManager } : {}),
      }),
      { ...(mcpManager ? { mcpManager } : {}), mcpConnections },
    );
  }

  // Restore path: rebuilds a live session from a persisted snapshot, re-injecting
  // the model client, built-in tools, and current system prompt. If the session
  // is already live, the request is idempotent and returns that entry rather
  // than creating a duplicate live object for the same id.
  async restore(
    id: string,
    options: RestoreSessionOptions = {},
  ): Promise<{ id: string }> {
    if (this.entries.has(id)) {
      return { id };
    }

    const snapshot = this.store.loadSnapshot(id);
    if (!snapshot) {
      throw new NotFoundException(`No persisted snapshot for session: ${id}`);
    }

    const mcpServers = this.resolveMcpServers(snapshot.cwd, options.mcpServers);
    const permissionContext = this.buildRestoredPermissionContext(
      snapshot,
      mcpServers,
    );
    const createOptions: CreateSessionOptions = {
      ...(snapshot.cwd ? { cwd: snapshot.cwd } : {}),
      permissionMode: snapshot.permissionMode,
      workspaceRoots: [...snapshot.workspaceRoots],
    };
    const { tools, mcpManager, mcpConnections } =
      await this.buildToolsAndMcp(mcpServers);
    return this.register(
      Session.restore(snapshot, {
        model: this.buildModelClient(id, options.model),
        tools,
        systemPrompt: buildSessionSystemPrompt(
          createOptions,
          permissionContext,
        ),
        compaction: buildCompactionConfig(options.model),
        ...(mcpManager ? { mcpManager } : {}),
      }),
      { ...(mcpManager ? { mcpManager } : {}), mcpConnections },
    );
  }

  async restoreCheckpoint(
    id: string,
    checkpointId: string,
    options: RestoreSessionOptions = {},
  ): Promise<{ id: string; checkpointId: string }> {
    const checkpoint = this.store.loadCheckpoint(id, checkpointId);
    if (!checkpoint) {
      throw new NotFoundException(
        `No checkpoint ${checkpointId} for session: ${id}`,
      );
    }

    const prepared = await this.prepareRestoredSession(
      checkpoint.snapshot,
      id,
      options,
    );
    await this.unregister(id, { persist: false });
    this.registerPreparedSession(prepared, {
      currentCheckpointId: checkpoint.id,
    });
    this.store.saveSnapshot(prepared.session.snapshot());
    return { id, checkpointId };
  }

  async forkCheckpoint(
    id: string,
    checkpointId: string,
    options: RestoreSessionOptions = {},
  ): Promise<{ id: string; checkpointId: string }> {
    const checkpoint = this.store.loadCheckpoint(id, checkpointId);
    if (!checkpoint) {
      throw new NotFoundException(
        `No checkpoint ${checkpointId} for session: ${id}`,
      );
    }

    const forkId = this.nextSessionId();
    const snapshot: SessionSnapshot = {
      ...structuredClone(checkpoint.snapshot),
      id: forkId,
    };
    const prepared = await this.prepareRestoredSession(snapshot, forkId, options);
    this.registerPreparedSession(prepared, {
      currentCheckpointId: checkpoint.id,
    });
    this.store.saveSnapshot(prepared.session.snapshot());
    const forkCheckpoint = this.buildCheckpoint(snapshot, {
      parentCheckpointId: checkpoint.id,
      label: 'Fork created',
      summary: checkpoint.summary ?? this.summarizeSnapshot(snapshot),
    });
    this.store.saveCheckpoint(forkCheckpoint);
    const entry = this.entries.get(forkId);
    if (entry) {
      entry.currentCheckpointId = forkCheckpoint.id;
    }
    return { id: forkId, checkpointId };
  }

  private async registerRestoredSnapshot(
    snapshot: SessionSnapshot,
    modelSessionId: string,
    options: RestoreSessionOptions,
    registerOptions: { currentCheckpointId?: string } = {},
  ): Promise<{ id: string }> {
    return this.registerPreparedSession(
      await this.prepareRestoredSession(snapshot, modelSessionId, options),
      registerOptions,
    );
  }

  private async prepareRestoredSession(
    snapshot: SessionSnapshot,
    modelSessionId: string,
    options: RestoreSessionOptions,
  ): Promise<PreparedSession> {
    const mcpServers = this.resolveMcpServers(snapshot.cwd, options.mcpServers);
    const permissionContext = this.buildRestoredPermissionContext(
      snapshot,
      mcpServers,
    );
    const createOptions: CreateSessionOptions = {
      ...(snapshot.cwd ? { cwd: snapshot.cwd } : {}),
      permissionMode: snapshot.permissionMode,
      workspaceRoots: [...snapshot.workspaceRoots],
    };
    const { tools, mcpManager, mcpConnections } =
      await this.buildToolsAndMcp(mcpServers);
    return {
      session: Session.restore(snapshot, {
        model: this.buildModelClient(modelSessionId, options.model),
        tools,
        systemPrompt: buildSessionSystemPrompt(
          createOptions,
          permissionContext,
        ),
        compaction: buildCompactionConfig(options.model),
        ...(mcpManager ? { mcpManager } : {}),
      }),
      ...(mcpManager ? { mcpManager } : {}),
      mcpConnections,
    };
  }

  private registerPreparedSession(
    prepared: PreparedSession,
    registerOptions: { currentCheckpointId?: string } = {},
  ): { id: string } {
    return this.register(
      prepared.session,
      {
        ...registerOptions,
        ...(prepared.mcpManager ? { mcpManager: prepared.mcpManager } : {}),
        mcpConnections: prepared.mcpConnections,
      },
    );
  }

  // Saves the session snapshot (upsert) and drains any buffered audit entries
  // into the append-only audit table. Drains in place so a subsequent flush does
  // not re-insert the same entries. Best-effort: a persistence failure must not
  // crash a live run, so it is swallowed (the run already surfaced its own
  // events). The snapshot never contains a secret (the engine excludes the
  // apiKey), and the audit carries only permission metadata.
  private persist(
    session: Session,
    pendingAudit: PermissionAuditEntry[],
  ): void {
    try {
      const snapshot: SessionSnapshot = session.snapshot();
      this.store.saveSnapshot(snapshot);
      if (pendingAudit.length > 0) {
        const drained = pendingAudit.splice(0, pendingAudit.length);
        this.store.appendAudit(session.id, drained);
      }
    } catch {
      // Swallow: persistence is a side channel; never let it break a run.
    }
  }

  private saveRunCheckpoint(
    entry: SessionEntry,
    event: Extract<SessionEvent, { type: 'run_status' }>,
  ): void {
    try {
      const checkpoint = this.buildCheckpoint(entry.session.snapshot(), {
        parentCheckpointId: entry.currentCheckpointId,
        runId: event.runId,
      });
      this.store.saveCheckpoint(checkpoint);
      entry.currentCheckpointId = checkpoint.id;
    } catch {
      // Like snapshot persistence, checkpointing is a side channel and must not
      // make a completed run appear failed.
    }
  }

  private buildCheckpoint(
    snapshot: SessionSnapshot,
    options: {
      parentCheckpointId?: string;
      runId?: string;
      label?: string;
      summary?: string;
    } = {},
  ): Checkpoint {
    const summary = options.summary ?? this.summarizeSnapshot(snapshot);
    return {
      id: this.nextCheckpointId(snapshot.id),
      sessionId: snapshot.id,
      ...(options.parentCheckpointId
        ? { parentCheckpointId: options.parentCheckpointId }
        : {}),
      createdAt: Date.now(),
      ...(options.runId ? { runId: options.runId } : {}),
      label: options.label ?? this.labelForSnapshot(snapshot),
      ...(summary ? { summary } : {}),
      snapshot,
    };
  }

  private labelForSnapshot(snapshot: SessionSnapshot): string {
    const userMessages = snapshot.history.filter(
      (entry) => entry.role === 'user',
    );
    return `Turn ${String(userMessages.length)}`;
  }

  private summarizeSnapshot(snapshot: SessionSnapshot): string {
    const lastUser = this.lastText(snapshot.history, 'user');
    const lastAssistant = this.lastText(snapshot.history, 'assistant');
    if (lastUser && lastAssistant) {
      return `User: ${lastUser}\nAssistant: ${lastAssistant}`;
    }
    return lastUser ? `User: ${lastUser}` : lastAssistant;
  }

  private lastText(
    history: ConversationEntry[],
    role: ConversationEntry['role'],
  ): string {
    const entry = [...history].reverse().find((item) => item.role === role);
    if (!entry) {
      return '';
    }
    return contentToText(entry.content).trim().slice(0, 500);
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  // Returns the entry or throws a 404. The single chokepoint for unknown ids.
  private require(id: string): SessionEntry {
    const entry = this.entries.get(id);
    if (!entry) {
      throw new NotFoundException(`Unknown session: ${id}`);
    }
    return entry;
  }

  // Fire-and-forget: append the user message and start the turn. Progress is
  // observed over the event stream; we deliberately do not await completion so
  // the HTTP request returns immediately (the run may park on an approval).
  submit(id: string, text: string): void {
    const { session } = this.require(id);
    void session.submit(text).catch(() => {
      // The turn loop already surfaces failures as `error` / `run_status:error`
      // events on the stream; swallow the rejection here so it does not become
      // an unhandled promise rejection.
    });
  }

  // Routes a validated control message into the engine (approval_response /
  // cancel / set_permission_mode / user_message).
  sendControl(id: string, message: ControlMessage): void {
    const { session } = this.require(id);
    session.send(message);
  }

  // An Observable of the session's events that REPLAYS the buffered log first,
  // then streams live events. Replay happens synchronously at subscribe time
  // against a frozen snapshot of the current log; a live listener registered in
  // the same tick catches everything emitted afterwards. This is what makes
  // subscribe-after-submit safe.
  events(id: string): Observable<SessionEvent> {
    const entry = this.require(id);
    return new Observable<SessionEvent>((subscriber) => {
      // 1) Replay everything buffered so far.
      for (const event of entry.log) {
        subscriber.next(event);
      }
      // 2) Stream live events from here on.
      const listener = (event: SessionEvent): void => {
        subscriber.next(event);
      };
      entry.listeners.add(listener);
      return () => {
        entry.listeners.delete(listener);
      };
    });
  }

  // Lifecycle: abort the run, drop the engine subscription, and remove the
  // entry. Returns false for an unknown id (idempotent dispose).
  async dispose(id: string): Promise<boolean> {
    const entry = this.entries.get(id);
    if (!entry) {
      return false;
    }
    entry.session.send({ type: 'cancel' });
    // Persist the final state (and flush any not-yet-flushed audit) before the
    // session leaves memory.
    this.persist(entry.session, entry.pendingAudit);
    entry.unsubscribe();
    entry.listeners.clear();
    this.entries.delete(id);
    await entry.mcpManager?.close?.();
    return true;
  }

  // Load path: the persisted snapshot for a session id, or `undefined` if none
  // was ever saved. Reads straight from the store — independent of whether the
  // session is still live in memory.
  loadSnapshot(id: string): SessionSnapshot | undefined {
    return this.store.loadSnapshot(id);
  }

  // The persisted permission-audit trail for a session id (insertion order).
  loadAudit(id: string): PermissionAuditEntry[] {
    return this.store.listAudit(id);
  }

  listCheckpoints(id: string): {
    checkpoints: Checkpoint[];
    currentCheckpointId?: string;
  } {
    const checkpoints = this.store.listCheckpoints(id);
    const currentCheckpointId =
      this.entries.get(id)?.currentCheckpointId ?? checkpoints.at(-1)?.id;
    return {
      checkpoints,
      ...(currentCheckpointId ? { currentCheckpointId } : {}),
    };
  }

  private async unregister(
    id: string,
    options: { persist: boolean },
  ): Promise<boolean> {
    const entry = this.entries.get(id);
    if (!entry) {
      return false;
    }
    entry.session.send({ type: 'cancel' });
    if (options.persist) {
      this.persist(entry.session, entry.pendingAudit);
    }
    entry.unsubscribe();
    entry.listeners.clear();
    this.entries.delete(id);
    await entry.mcpManager?.close?.();
    return true;
  }

  // Disposes every session so tests (and shutdown) do not leak runs/timers.
  async onModuleDestroy(): Promise<void> {
    await Promise.all([...this.entries.keys()].map((id) => this.dispose(id)));
  }
}
