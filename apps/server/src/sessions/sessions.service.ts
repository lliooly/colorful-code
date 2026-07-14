import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Observable } from 'rxjs';
import {
  createBuiltinTools,
  createLspRuntimeTools,
  createMcpRuntimeTools,
  createUnconfiguredModelClient,
  SdkLspManager,
  SdkMcpManager,
  Session,
  SwappableModelClient,
  buildMcpToolName,
  contentToText,
  normalizeMcpName,
  type Checkpoint,
  type ControlMessage,
  type ConversationEntry,
  type McpManager,
  type McpServerConnection,
  type LspManager,
  type LspServerConnection,
  type PermissionAuditEntry,
  type PermissionContext,
  type PermissionMode,
  type PermissionRule,
  type SessionEvent,
  type McpServerStatus,
  type LspServerStatus,
  type SessionSnapshot,
  type HookAuditEntry,
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
import {
  VoiceTranscriptionService,
  type VoiceAudioChunk,
  type VoiceStartOptions,
} from './voice-transcription';
import { buildCompactionConfig } from './compaction-config';
import { SessionStore } from '../persistence/session-store';
import {
  loadMcpServersFromEnv,
  loadProjectMcpServers,
  mergeMcpServers,
  type McpServersConfig,
} from '../config/mcp-config';
import {
  loadLspServersFromEnv,
  loadProjectLspServers,
  mergeLspServers,
  type LspServersConfig,
} from '../config/lsp-config';
import { PluginStore } from '../plugins/plugin-store';

// Options accepted by `POST /sessions` to seed a session's PermissionContext and
// (optionally) choose the model. `model` is the validated per-request selection;
// absent means the server default. The apiKey inside a selection (custom BYO
// path) is forwarded to the factory and never stored on the session.
export type CreateSessionOptions = {
  projectId?: string;
  permissionMode?: PermissionMode;
  workspaceRoots?: string[];
  rules?: PermissionRule[];
  cwd?: string;
  model?: ModelSelection;
  mcpServers?: McpServersConfig;
  lspServers?: LspServersConfig;
  watchWorkspace?: boolean;
};

export type CreateSessionResponse = {
  id: string;
  needsModelConfig: boolean;
};

export type RestoreSessionOptions = {
  model?: ModelSelection;
  mcpServers?: McpServersConfig;
  lspServers?: LspServersConfig;
  watchWorkspace?: boolean;
};

export type RestoreSessionResponse = {
  id: string;
  needsModelConfig: boolean;
  history: ConversationEntry[];
  permissionMode: PermissionMode;
};

export type RestoreCheckpointResponse = {
  id: string;
  checkpointId: string;
  needsModelConfig: boolean;
  history: ConversationEntry[];
  permissionMode: PermissionMode;
};

export type SessionSummary = {
  id: string;
  title: string;
  updatedAt: number;
  cwd?: string;
  checkpointId?: string;
  pinned: boolean;
  projectId?: string;
};

export type ProjectSummary = {
  id: string;
  name: string;
  path: string;
  createdAt: number;
  updatedAt: number;
};

export type ProjectWithChats = ProjectSummary & {
  chats: SessionSummary[];
};

export type GroupedSessionHistory = {
  projects: ProjectWithChats[];
  chats: SessionSummary[];
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
  lspManager?: LspManager;
  currentCheckpointId?: string;
  // Permission-audit entries observed since the last persistence flush. Drained
  // into the append-only audit table when a run reaches a terminal status (and
  // on dispose) so the table never holds duplicates of an already-flushed entry.
  pendingAudit: PermissionAuditEntry[];
  persistenceQueue?: Promise<void>;
  // True when the session was created without a valid model config (e.g.
  // missing API key). The session holds a placeholder model that can be
  // swapped for a real one once the user provides credentials.
  needsModelConfig: boolean;
  // The swappable wrapper around the model client, present only when
  // needsModelConfig is true so the delegate can be upgraded in-place.
  swappableModel?: SwappableModelClient;
};

type PreparedSession = {
  session: Session;
  mcpManager?: McpManager;
  lspManager?: LspManager;
  mcpConnections: McpServerConnection[];
  lspConnections: LspServerConnection[];
  needsModelConfig: boolean;
  swappableModel?: SwappableModelClient;
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
const RECENT_SESSION_PRELOAD_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

function hookAuditBehavior(
  entry: HookAuditEntry,
): PermissionAuditEntry['behavior'] {
  if (entry.action === 'deny' || entry.action === 'failure') {
    return 'deny';
  }
  if (entry.action === 'ask') {
    return 'ask';
  }
  return 'allow';
}

function hookAuditToPermissionEntry(
  entry: HookAuditEntry,
): PermissionAuditEntry {
  return {
    toolUseId: entry.hookId,
    toolName: 'Hook:' + entry.event,
    behavior: hookAuditBehavior(entry),
    reason: {
      type: 'hook',
      hookId: entry.hookId,
      reason: entry.error ?? entry.message ?? entry.action,
    },
    at: entry.at,
  };
}

@Injectable()
export class SessionsService implements OnModuleInit, OnModuleDestroy {
  private readonly entries = new Map<string, SessionEntry>();
  private readonly liveMetadata = new Map<
    string,
    { projectId?: string; pinned: boolean; updatedAt: number }
  >();
  private sessionOrdinal = 0;
  private checkpointOrdinal = 0;
  private readonly advisoryWrites = new Set<Promise<void>>();

  constructor(
    @Inject(MODEL_CLIENT_FACTORY)
    private readonly modelClientFactory: ModelClientFactory,
    private readonly store: SessionStore,
    @Optional()
    private readonly voiceTranscription?: VoiceTranscriptionService,
    @Optional()
    private readonly pluginStore?: PluginStore,
  ) {}

  onModuleInit(): void {
    queueMicrotask(() => {
      void this.preloadRecentSessions();
    });
  }

  async preloadRecentSessions(now = Date.now()): Promise<void> {
    const cutoff = now - RECENT_SESSION_PRELOAD_WINDOW_MS;
    let persisted: Array<{ snapshot: SessionSnapshot; updatedAt: number }>;
    try {
      persisted = this.store.listSessions();
    } catch {
      return;
    }

    for (const entry of persisted) {
      if (entry.updatedAt < cutoff || this.entries.has(entry.snapshot.id)) {
        continue;
      }
      try {
        await this.restore(entry.snapshot.id);
      } catch {
        // Startup preloading is an optimization. A corrupt or unavailable
        // session should not prevent the server from becoming ready.
      }
    }
  }

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

  private toLspServerStatus(connection: LspServerConnection): LspServerStatus {
    if (connection.type === 'failed') {
      return {
        name: connection.name,
        language: connection.language,
        fileExtensions: [...connection.config.fileExtensions],
        status: 'failed',
        error: connection.error,
      };
    }
    return {
      name: connection.name,
      language: connection.language,
      fileExtensions: [...connection.config.fileExtensions],
      status: 'connected',
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
        this.pluginStore?.enabledMcpServers(),
        requestMcpServers,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new BadRequestException(message);
    }
  }

  private resolveLspServers(
    cwd: string | undefined,
    requestLspServers: LspServersConfig | undefined,
  ): LspServersConfig {
    try {
      return mergeLspServers(
        loadProjectLspServers(cwd),
        loadLspServersFromEnv(process.env),
        this.pluginStore?.enabledLspServers(),
        requestLspServers,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new BadRequestException(message);
    }
  }

  private async buildToolsMcpAndLsp(
    cwd: string | undefined,
    mcpServers: McpServersConfig,
    lspServers: LspServersConfig,
  ): Promise<{
    tools: ReturnType<typeof createBuiltinTools>;
    mcpManager?: McpManager;
    mcpConnections: McpServerConnection[];
    lspManager?: LspManager;
    lspConnections: LspServerConnection[];
  }> {
    let tools = createBuiltinTools();
    let mcpManager: McpManager | undefined;
    let lspManager: LspManager | undefined;
    let mcpConnections: McpServerConnection[] = [];
    let lspConnections: LspServerConnection[] = [];

    if (Object.keys(mcpServers).length === 0) {
      mcpConnections = [];
    } else {
      const manager = new SdkMcpManager(mcpServers);
      const mcpTools = await createMcpRuntimeTools(manager);
      const mcpBuiltinNames = new Set([
        'MCPTool',
        'McpAuth',
        'ListMcpResourcesTool',
        'ReadMcpResourceTool',
      ]);
      tools = tools.filter((tool) => !mcpBuiltinNames.has(tool.name));
      mcpConnections = await manager.connectAll();
      tools = [...tools, ...mcpTools];
      mcpManager = manager;
    }

    if (Object.keys(lspServers).length > 0) {
      const manager = new SdkLspManager(lspServers);
      lspConnections = await manager.initialize(cwd ?? process.cwd());
      tools = [...tools, ...(await createLspRuntimeTools())];
      lspManager = manager;
    }

    return {
      tools,
      ...(mcpManager ? { mcpManager } : {}),
      mcpConnections,
      ...(lspManager ? { lspManager } : {}),
      lspConnections,
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

  // Attempts to build a model client. Returns `undefined` when the selected
  // preset has no API key configured (instead of throwing) so session creation
  // can proceed with a placeholder model that is upgraded later.
  private tryBuildModelClient(
    id: string,
    selection?: ModelSelection,
  ): ReturnType<typeof this.buildModelClient> | undefined {
    try {
      return this.buildModelClient(id, selection);
    } catch (error) {
      if (error instanceof BadRequestException) {
        const message = error.message ?? '';
        if (
          message.includes('No API key configured') ||
          message.includes('requires an `apiKey`')
        ) {
          return undefined;
        }
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
      lspManager?: LspManager;
      lspConnections?: LspServerConnection[];
      currentCheckpointId?: string;
      needsModelConfig?: boolean;
      swappableModel?: SwappableModelClient;
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
      needsModelConfig: options.needsModelConfig ?? false,
      ...(options.currentCheckpointId
        ? { currentCheckpointId: options.currentCheckpointId }
        : {}),
      ...(options.mcpManager ? { mcpManager: options.mcpManager } : {}),
      ...(options.lspManager ? { lspManager: options.lspManager } : {}),
      ...(options.swappableModel
        ? { swappableModel: options.swappableModel }
        : {}),
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
      } else if (event.type === 'hook_event') {
        pendingAudit.push(hookAuditToPermissionEntry(event.entry));
      } else if (
        event.type === 'run_status' &&
        TERMINAL_RUN_STATUSES.has(event.status)
      ) {
        void this.enqueuePersistence(entry, async () => {
          const persistence = this.persist(session, pendingAudit);
          const checkpoint = this.saveRunCheckpoint(entry, event);
          await persistence;
          await checkpoint;
        });
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
    if (options.lspConnections && options.lspConnections.length > 0) {
      log.push({
        type: 'lsp_status',
        servers: options.lspConnections.map((connection) =>
          this.toLspServerStatus(connection),
        ),
      });
    }

    // Replay stored edit proposals into the log so late SSE subscribers
    // see them immediately (persisted across restores).
    const storedProposals = session.context.editProposals;
    if (storedProposals && storedProposals.size > 0) {
      for (const proposal of storedProposals.values()) {
        log.push({
          type: 'edit_proposed',
          runId: session.id,
          proposalId: proposal.id,
          toolUseId: proposal.toolUseId,
          patches: proposal.patches,
        });
      }
    }

    // Emit the last-known context token usage so the frontend shows it.
    if (session.currentInputTokens > 0) {
      log.push({
        type: 'usage',
        runId: session.id,
        inputTokens: session.currentInputTokens,
      });
    }

    this.entries.set(session.id, entry);
    return { id: session.id };
  }

  // Creates a session, wires its event subscription to the replay buffer + live
  // listeners, and registers it. The model client is built per session via the
  // injected factory; tools are the built-ins.
  //
  // When the selected model preset has no API key configured, the session is
  // still created with a placeholder model so the user can browse history. A
  // red warning is shown in the UI and the first submit will try to rebuild
  // with any newly configured credentials.
  async create(
    options: CreateSessionOptions = {},
  ): Promise<CreateSessionResponse> {
    const scopedOptions = this.resolveProjectScope(options);
    const mcpServers = this.resolveMcpServers(
      scopedOptions.cwd,
      scopedOptions.mcpServers,
    );
    const lspServers = this.resolveLspServers(
      scopedOptions.cwd,
      scopedOptions.lspServers,
    );
    const permissionContext = this.buildPermissionContext(
      scopedOptions,
      mcpServers,
    );

    // Mint the id up front so the factory can key on it if needed.
    const id = this.nextSessionId();

    // Build the model client. If no key is configured for the selected preset,
    // fall back to a placeholder — the session is still usable for browsing and
    // the model can be upgraded later via configureModel() or automatically on
    // the first submit.
    let needsModelConfig = false;
    let model = this.tryBuildModelClient(id, options.model);
    if (!model) {
      model = createUnconfiguredModelClient();
      needsModelConfig = true;
    }
    const swappableModel = new SwappableModelClient(model);
    const effectiveModel = swappableModel;

    const { tools, mcpManager, mcpConnections, lspManager, lspConnections } =
      await this.buildToolsMcpAndLsp(scopedOptions.cwd, mcpServers, lspServers);

    const session = new Session({
      id,
      model: effectiveModel,
      tools,
      systemPrompt: buildSessionSystemPrompt(scopedOptions, permissionContext),
      compaction: buildCompactionConfig(scopedOptions.model),
      ...(scopedOptions.cwd ? { cwd: scopedOptions.cwd } : {}),
      permissionContext,
      ...(mcpManager ? { mcpManager } : {}),
      ...(lspManager ? { lspManager } : {}),
      ...(scopedOptions.watchWorkspace ? { watchWorkspace: true } : {}),
    });
    const registered = this.register(session, {
      ...(mcpManager ? { mcpManager } : {}),
      mcpConnections,
      ...(lspManager ? { lspManager } : {}),
      lspConnections,
      needsModelConfig,
      swappableModel,
    });
    this.liveMetadata.set(id, {
      ...(scopedOptions.projectId
        ? { projectId: scopedOptions.projectId }
        : {}),
      pinned: false,
      updatedAt: this.store.now(),
    });
    await this.safeUpsertSessionMetadata({
      sessionId: id,
      projectId: scopedOptions.projectId ?? null,
    });
    return { id: registered.id, needsModelConfig };
  }

  private resolveProjectScope(
    options: CreateSessionOptions,
  ): CreateSessionOptions {
    if (!options.projectId) {
      return options;
    }
    const project = this.store.loadProject(options.projectId);
    if (!project) {
      throw new NotFoundException(`Unknown project: ${options.projectId}`);
    }
    return {
      ...options,
      cwd: options.cwd ?? project.path,
      workspaceRoots: options.workspaceRoots ?? [project.path],
    };
  }

  // Restore path: rebuilds a live session from a persisted snapshot, re-injecting
  // the model client, built-in tools, and current system prompt. If the session
  // is already live, the request is idempotent and returns that entry rather
  // than creating a duplicate live object for the same id.
  //
  // Like create(), tolerates a missing API key by using a placeholder model so
  // the user can always view their history.
  async restore(
    id: string,
    options: RestoreSessionOptions = {},
  ): Promise<RestoreSessionResponse> {
    if (this.entries.has(id)) {
      const entry = this.entries.get(id);
      return {
        id,
        needsModelConfig: entry?.needsModelConfig ?? false,
        history: entry?.session.snapshot().history ?? [],
        permissionMode: entry?.session.snapshot().permissionMode ?? 'default',
      };
    }

    const snapshot = this.store.loadSnapshot(id);
    if (!snapshot) {
      throw new NotFoundException(`No persisted snapshot for session: ${id}`);
    }

    const mcpServers = this.resolveMcpServers(snapshot.cwd, options.mcpServers);
    const lspServers = this.resolveLspServers(snapshot.cwd, options.lspServers);
    const permissionContext = this.buildRestoredPermissionContext(
      snapshot,
      mcpServers,
    );
    const createOptions: CreateSessionOptions = {
      ...(snapshot.cwd ? { cwd: snapshot.cwd } : {}),
      permissionMode: snapshot.permissionMode,
      workspaceRoots: [...snapshot.workspaceRoots],
    };
    const { tools, mcpManager, mcpConnections, lspManager, lspConnections } =
      await this.buildToolsMcpAndLsp(snapshot.cwd, mcpServers, lspServers);

    let needsModelConfig = false;
    let model = this.tryBuildModelClient(id, options.model);
    if (!model) {
      model = createUnconfiguredModelClient();
      needsModelConfig = true;
    }
    const swappableModel = new SwappableModelClient(model);
    const effectiveModel = swappableModel;

    const registered = this.register(
      Session.restore(snapshot, {
        model: effectiveModel,
        tools,
        systemPrompt: buildSessionSystemPrompt(
          createOptions,
          permissionContext,
        ),
        compaction: buildCompactionConfig(options.model),
        permissionContext,
        ...(mcpManager ? { mcpManager } : {}),
        ...(lspManager ? { lspManager } : {}),
        ...(options.watchWorkspace ? { watchWorkspace: true } : {}),
      }),
      {
        ...(mcpManager ? { mcpManager } : {}),
        mcpConnections,
        ...(lspManager ? { lspManager } : {}),
        lspConnections,
        needsModelConfig,
        swappableModel,
      },
    );
    return {
      id: registered.id,
      needsModelConfig,
      history: snapshot.history,
      permissionMode: snapshot.permissionMode,
    };
  }

  async restoreCheckpoint(
    id: string,
    checkpointId: string,
    options: RestoreSessionOptions = {},
  ): Promise<RestoreCheckpointResponse> {
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
    const registered = this.registerPreparedSession(prepared, {
      currentCheckpointId: checkpoint.id,
    });
    await this.store.saveSnapshot(prepared.session.snapshot());
    await this.inheritSessionMetadata(id, id);
    return {
      id,
      checkpointId,
      needsModelConfig: registered.needsModelConfig,
      history: checkpoint.snapshot.history,
      permissionMode: checkpoint.snapshot.permissionMode,
    };
  }

  async forkCheckpoint(
    id: string,
    checkpointId: string,
    options: RestoreSessionOptions = {},
  ): Promise<RestoreCheckpointResponse> {
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
    const prepared = await this.prepareRestoredSession(
      snapshot,
      forkId,
      options,
    );
    const registered = this.registerPreparedSession(prepared, {
      currentCheckpointId: checkpoint.id,
    });
    await this.store.saveSnapshot(prepared.session.snapshot());
    await this.inheritSessionMetadata(id, forkId);
    const forkCheckpoint = this.buildCheckpoint(snapshot, {
      parentCheckpointId: checkpoint.id,
      label: 'Fork created',
      summary: checkpoint.summary ?? this.summarizeSnapshot(snapshot),
    });
    await this.store.saveCheckpoint(forkCheckpoint);
    const entry = this.entries.get(forkId);
    if (entry) {
      entry.currentCheckpointId = forkCheckpoint.id;
    }
    return {
      id: forkId,
      checkpointId,
      needsModelConfig: registered.needsModelConfig,
      history: checkpoint.snapshot.history,
      permissionMode: checkpoint.snapshot.permissionMode,
    };
  }

  private async registerRestoredSnapshot(
    snapshot: SessionSnapshot,
    modelSessionId: string,
    options: RestoreSessionOptions,
    registerOptions: { currentCheckpointId?: string } = {},
  ): Promise<{ id: string; needsModelConfig: boolean }> {
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
    const lspServers = this.resolveLspServers(snapshot.cwd, options.lspServers);
    const permissionContext = this.buildRestoredPermissionContext(
      snapshot,
      mcpServers,
    );
    const createOptions: CreateSessionOptions = {
      ...(snapshot.cwd ? { cwd: snapshot.cwd } : {}),
      permissionMode: snapshot.permissionMode,
      workspaceRoots: [...snapshot.workspaceRoots],
    };
    const { tools, mcpManager, mcpConnections, lspManager, lspConnections } =
      await this.buildToolsMcpAndLsp(snapshot.cwd, mcpServers, lspServers);

    let needsModelConfig = false;
    let model = this.tryBuildModelClient(modelSessionId, options.model);
    if (!model) {
      model = createUnconfiguredModelClient();
      needsModelConfig = true;
    }
    const swappableModel = new SwappableModelClient(model);
    const effectiveModel = swappableModel;

    return {
      session: Session.restore(snapshot, {
        model: effectiveModel,
        tools,
        systemPrompt: buildSessionSystemPrompt(
          createOptions,
          permissionContext,
        ),
        compaction: buildCompactionConfig(options.model),
        permissionContext,
        ...(mcpManager ? { mcpManager } : {}),
        ...(lspManager ? { lspManager } : {}),
        ...(options.watchWorkspace ? { watchWorkspace: true } : {}),
      }),
      ...(mcpManager ? { mcpManager } : {}),
      ...(lspManager ? { lspManager } : {}),
      mcpConnections,
      lspConnections,
      needsModelConfig,
      swappableModel,
    };
  }

  private registerPreparedSession(
    prepared: PreparedSession,
    registerOptions: { currentCheckpointId?: string } = {},
  ): { id: string; needsModelConfig: boolean } {
    return {
      ...this.register(prepared.session, {
        ...registerOptions,
        ...(prepared.mcpManager ? { mcpManager: prepared.mcpManager } : {}),
        mcpConnections: prepared.mcpConnections,
        ...(prepared.lspManager ? { lspManager: prepared.lspManager } : {}),
        lspConnections: prepared.lspConnections,
        needsModelConfig: prepared.needsModelConfig,
        ...(prepared.swappableModel
          ? { swappableModel: prepared.swappableModel }
          : {}),
      }),
      needsModelConfig: prepared.needsModelConfig,
    };
  }

  // Saves the session snapshot (upsert) and drains any buffered audit entries
  // into the append-only audit table. Drains in place so a subsequent flush does
  // not re-insert the same entries. Best-effort: a persistence failure must not
  // crash a live run, so it is swallowed (the run already surfaced its own
  // events). The snapshot never contains a secret (the engine excludes the
  // apiKey), and the audit carries only permission metadata.
  private async persist(
    session: Session,
    pendingAudit: PermissionAuditEntry[],
  ): Promise<void> {
    if (this.store.isClosed) return;
    try {
      const snapshot: SessionSnapshot = session.snapshot();
      await this.store.saveSnapshot(snapshot);
      const metadata = this.liveMetadata.get(session.id);
      if (metadata) {
        await this.store.upsertSessionMetadata({
          sessionId: session.id,
          projectId: metadata.projectId ?? null,
          pinned: metadata.pinned,
        });
      }
      if (pendingAudit.length > 0) {
        const batch = pendingAudit.slice();
        await this.store.appendAudit(session.id, batch);
        pendingAudit.splice(0, batch.length);
      }
    } catch (error) {
      // Swallow: persistence is a side channel; never let it break a run.
      console.error('Failed to persist session state:', error);
    }
  }

  private async saveRunCheckpoint(
    entry: SessionEntry,
    event: Extract<SessionEvent, { type: 'run_status' }>,
  ): Promise<void> {
    try {
      const checkpoint = this.buildCheckpoint(entry.session.snapshot(), {
        parentCheckpointId: entry.currentCheckpointId,
        runId: event.runId,
      });
      await this.store.saveCheckpoint(checkpoint);
      entry.currentCheckpointId = checkpoint.id;
    } catch {
      // Like snapshot persistence, checkpointing is a side channel and must not
      // make a completed run appear failed.
    }
  }

  private enqueuePersistence(
    entry: SessionEntry,
    operation: () => Promise<void>,
  ): Promise<void> {
    const previous = entry.persistenceQueue;
    const operationPromise = previous
      ? previous.then(operation, operation)
      : operation();
    const tracked = operationPromise.finally(() => {
      if (entry.persistenceQueue === tracked) {
        entry.persistenceQueue = undefined;
      }
    });
    entry.persistenceQueue = tracked;
    return tracked;
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
      createdAt: this.store.now(),
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

  private emitEvent(id: string, event: SessionEvent): void {
    const entry = this.require(id);
    entry.log.push(event);
    for (const listener of entry.listeners) {
      listener(event);
    }
  }

  startVoiceTranscription(
    id: string,
    requestId: string,
    options: VoiceStartOptions,
  ): void {
    this.require(id);
    if (!this.voiceTranscription) {
      throw new BadRequestException('Voice transcription is not available.');
    }
    this.voiceTranscription.start(id, requestId, options, (event) =>
      this.emitEvent(id, event),
    );
  }

  appendVoiceAudio(id: string, chunk: VoiceAudioChunk): void {
    this.require(id);
    if (!this.voiceTranscription) {
      throw new BadRequestException('Voice transcription is not available.');
    }
    this.voiceTranscription.appendAudio(id, chunk);
  }

  stopVoiceTranscription(id: string): void {
    this.require(id);
    this.voiceTranscription?.stop(id);
  }

  // Fire-and-forget: append the user message and start the turn. Progress is
  // observed over the event stream; we deliberately do not await completion so
  // the HTTP request returns immediately (the run may park on an approval).
  //
  // When the session was created without a valid model config, this method first
  // tries to rebuild the model client with any newly configured credentials. If
  // none are available yet, it emits an error event and does not submit.
  submit(id: string, text: string): void {
    const entry = this.require(id);
    if (entry.needsModelConfig) {
      const rebuilt = this.tryRebuildModel(id);
      if (!rebuilt) {
        this.emitModelConfigError(id);
        return;
      }
    }
    void entry.session.submit(text).catch(() => {
      // The turn loop already surfaces failures as `error` / `run_status:error`
      // events on the stream; swallow the rejection here so it does not become
      // an unhandled promise rejection.
    });
  }

  // Attempts to upgrade a placeholder model to a real one. Returns true if the
  // upgrade succeeded or the session already had a valid model.
  private tryRebuildModel(id: string): boolean {
    const entry = this.entries.get(id);
    if (!entry) {
      return false;
    }
    if (!entry.needsModelConfig || !entry.swappableModel) {
      return true; // Already configured — nothing to do.
    }
    const model = this.tryBuildModelClient(id);
    if (!model) {
      return false;
    }
    entry.swappableModel.swap(model);
    entry.needsModelConfig = false;
    return true;
  }

  // Updates the model for a live session. Called by the frontend after the user
  // configures an API key. Swaps the underlying model client and clears the
  // `needsModelConfig` flag so subsequent submits work.
  configureModel(
    id: string,
    selection: ModelSelection,
  ): { needsModelConfig: boolean } {
    const entry = this.require(id);
    const model = this.tryBuildModelClient(id, selection);
    if (model) {
      entry.swappableModel?.swap(model);
      entry.needsModelConfig = false;
      return { needsModelConfig: false };
    }
    entry.needsModelConfig = true;
    return { needsModelConfig: true };
  }

  // Returns whether a session currently lacks a valid model config so the
  // frontend can show a warning.
  getNeedsModelConfig(id: string): boolean {
    const entry = this.entries.get(id);
    return entry?.needsModelConfig ?? false;
  }

  private emitModelConfigError(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    const event: SessionEvent = {
      type: 'error',
      runId: id,
      message:
        'No API key configured. Please set an API key for your model provider in Settings, then try again.',
    };
    entry.log.push(event);
    for (const listener of entry.listeners) {
      listener(event);
    }
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
    this.voiceTranscription?.stop(id);
    // Persist the final state (and flush any not-yet-flushed audit) before the
    // session leaves memory.
    await this.enqueuePersistence(entry, () =>
      this.persist(entry.session, entry.pendingAudit),
    );
    await entry.session.close();
    entry.unsubscribe();
    entry.listeners.clear();
    this.entries.delete(id);
    this.liveMetadata.delete(id);
    await entry.mcpManager?.close?.();
    await entry.lspManager?.close?.();
    return true;
  }

  // Load path: the persisted snapshot for a session id, or `undefined` if none
  // was ever saved. Reads straight from the store — independent of whether the
  // session is still live in memory.
  loadSnapshot(id: string): SessionSnapshot | undefined {
    return this.store.loadSnapshot(id);
  }

  getLiveSnapshot(id: string): SessionSnapshot | undefined {
    return this.entries.get(id)?.session.snapshot();
  }

  // The persisted permission-audit trail for a session id (insertion order).
  loadAudit(id: string): PermissionAuditEntry[] {
    return this.store.listAudit(id);
  }

  listSessions(): GroupedSessionHistory {
    const projects = this.store.listProjects();
    const projectById = new Map(
      projects.map((project) => [project.id, project]),
    );
    const projectByPath = new Map(
      projects.map((project) => [project.path, project]),
    );
    const grouped = new Map<string, SessionSummary[]>(
      projects.map((project) => [project.id, []]),
    );
    const chats: SessionSummary[] = [];
    const seen = new Set<string>();

    for (const entry of this.store.listSessions()) {
      seen.add(entry.snapshot.id);
      const summary = this.toSessionSummary(entry);
      const projectId = this.resolveHistoryProjectId(
        entry.snapshot.id,
        entry.snapshot.cwd,
        projectByPath,
      );
      const scopedSummary: SessionSummary = {
        ...summary,
        ...(projectId ? { projectId } : {}),
      };
      if (projectId && projectById.has(projectId)) {
        grouped.get(projectId)?.push(scopedSummary);
      } else {
        chats.push(scopedSummary);
      }
    }

    for (const [id, live] of this.entries) {
      if (seen.has(id)) {
        continue;
      }
      const snapshot = live.session.snapshot();
      const summary = this.toSessionSummary({
        snapshot,
        updatedAt: this.liveMetadata.get(id)?.updatedAt ?? this.store.now(),
      });
      const projectId = this.resolveHistoryProjectId(
        snapshot.id,
        snapshot.cwd,
        projectByPath,
      );
      const scopedSummary: SessionSummary = {
        ...summary,
        ...(projectId ? { projectId } : {}),
      };
      if (projectId && projectById.has(projectId)) {
        grouped.get(projectId)?.push(scopedSummary);
      } else {
        chats.push(scopedSummary);
      }
    }

    return {
      projects: projects.map((project) => ({
        ...project,
        chats: this.sortSummaries(grouped.get(project.id) ?? []),
      })),
      chats: this.sortSummaries(chats),
    };
  }

  async updateSession(
    id: string,
    patch: { pinned?: boolean },
  ): Promise<SessionSummary> {
    if (!this.entries.has(id) && !this.safeLoadSnapshot(id)) {
      throw new NotFoundException(`Unknown session: ${id}`);
    }
    if (patch.pinned !== undefined) {
      const live = this.liveMetadata.get(id);
      if (live) {
        this.liveMetadata.set(id, {
          ...live,
          pinned: patch.pinned,
          updatedAt: this.store.now(),
        });
      }
      try {
        await this.store.setSessionPinned(id, patch.pinned);
      } catch {
        // Live sessions keep the visible pin state in memory until persistence
        // is available.
      }
    }
    const snapshot =
      this.safeLoadSnapshot(id) ?? this.entries.get(id)?.session.snapshot();
    if (!snapshot) {
      throw new NotFoundException(`Unknown session: ${id}`);
    }
    const listed = this.store
      .listSessions()
      .find((entry) => entry.snapshot.id === id);
    return this.toSessionSummary({
      snapshot,
      updatedAt: listed?.updatedAt ?? this.store.now(),
    });
  }

  async deleteSession(id: string): Promise<boolean> {
    const existed =
      this.entries.has(id) ||
      this.safeLoadSnapshot(id) !== undefined ||
      this.safeLoadSessionMetadata(id) !== undefined ||
      this.liveMetadata.has(id);
    await this.unregister(id, { persist: false });
    this.liveMetadata.delete(id);
    const deleted = await this.safeDeleteSession(id);
    return existed || deleted;
  }

  async clearSessions(
    scope: {
      projectId?: string;
      standalone?: boolean;
    } = {},
  ): Promise<void> {
    const history = this.listSessions();
    const ids =
      scope.projectId !== undefined
        ? (
            history.projects.find((project) => project.id === scope.projectId)
              ?.chats ?? []
          ).map((chat) => chat.id)
        : scope.standalone
          ? history.chats.map((chat) => chat.id)
          : [
              ...history.chats.map((chat) => chat.id),
              ...history.projects.flatMap((project) =>
                project.chats.map((chat) => chat.id),
              ),
            ];

    await Promise.all(ids.map((id) => this.unregister(id, { persist: false })));
    await this.store.deleteSessions(ids);
  }

  async deleteProject(projectId: string): Promise<boolean> {
    if (!this.store.loadProject(projectId)) {
      return false;
    }
    const ids =
      this.listSessions()
        .projects.find((project) => project.id === projectId)
        ?.chats.map((chat) => chat.id) ?? [];

    await Promise.all(ids.map((id) => this.unregister(id, { persist: false })));
    await this.store.deleteSessions(ids);
    return await this.store.deleteProject(projectId);
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
    this.voiceTranscription?.stop(id);
    if (options.persist) {
      await this.enqueuePersistence(entry, () =>
        this.persist(entry.session, entry.pendingAudit),
      );
    } else {
      await entry.persistenceQueue;
    }
    await entry.session.close();
    entry.unsubscribe();
    entry.listeners.clear();
    this.entries.delete(id);
    this.liveMetadata.delete(id);
    await entry.mcpManager?.close?.();
    await entry.lspManager?.close?.();
    return true;
  }

  private toSessionSummary(entry: {
    snapshot: SessionSnapshot;
    updatedAt: number;
  }): SessionSummary {
    const checkpoints = this.store.listCheckpoints(entry.snapshot.id);
    const latestCheckpoint = checkpoints.at(-1);
    const metadata = this.safeLoadSessionMetadata(entry.snapshot.id);
    const liveMetadata = this.liveMetadata.get(entry.snapshot.id);
    return {
      id: entry.snapshot.id,
      title: latestCheckpoint?.summary ?? sessionTitle(entry.snapshot),
      updatedAt: latestCheckpoint?.createdAt ?? entry.updatedAt,
      pinned: liveMetadata?.pinned ?? metadata?.pinned ?? false,
      ...(entry.snapshot.cwd !== undefined ? { cwd: entry.snapshot.cwd } : {}),
      ...(latestCheckpoint ? { checkpointId: latestCheckpoint.id } : {}),
      ...((liveMetadata?.projectId ?? metadata?.projectId)
        ? { projectId: liveMetadata?.projectId ?? metadata?.projectId }
        : {}),
    };
  }

  private resolveHistoryProjectId(
    sessionId: string,
    cwd: string | undefined,
    projectByPath: Map<string, ProjectSummary>,
  ): string | undefined {
    const metadata = this.safeLoadSessionMetadata(sessionId);
    const liveMetadata = this.liveMetadata.get(sessionId);
    if (liveMetadata) {
      return liveMetadata.projectId;
    }
    if (metadata) {
      return metadata.projectId;
    }
    const project = cwd ? projectByPath.get(cwd) : undefined;
    if (project) {
      void this.safeUpsertSessionMetadata({
        sessionId,
        projectId: project.id,
      });
    }
    return project?.id;
  }

  private sortSummaries(summaries: SessionSummary[]): SessionSummary[] {
    return [...summaries].sort((a, b) => {
      if (a.pinned !== b.pinned) {
        return a.pinned ? -1 : 1;
      }
      if (a.updatedAt !== b.updatedAt) {
        return b.updatedAt - a.updatedAt;
      }
      return a.id.localeCompare(b.id);
    });
  }

  private async inheritSessionMetadata(
    sourceId: string,
    targetId: string,
  ): Promise<void> {
    const source = this.safeLoadSessionMetadata(sourceId);
    const liveSource = this.liveMetadata.get(sourceId);
    this.liveMetadata.set(targetId, {
      ...((liveSource?.projectId ?? source?.projectId)
        ? { projectId: liveSource?.projectId ?? source?.projectId }
        : {}),
      pinned: false,
      updatedAt: this.store.now(),
    });
    await this.safeUpsertSessionMetadata({
      sessionId: targetId,
      projectId: liveSource?.projectId ?? source?.projectId ?? null,
      pinned: false,
    });
  }

  private safeUpsertSessionMetadata(input: {
    sessionId: string;
    projectId?: string | null;
    pinned?: boolean;
  }): Promise<void> {
    const write = (async () => {
      try {
        await this.store.upsertSessionMetadata(input);
      } catch {
        // Some focused service tests provide a minimal SessionStore mock.
        // Metadata persistence is advisory until a real store is present.
      }
    })();
    this.advisoryWrites.add(write);
    void write.finally(() => this.advisoryWrites.delete(write));
    return write;
  }

  private safeLoadSnapshot(id: string): SessionSnapshot | undefined {
    try {
      return this.store.loadSnapshot(id);
    } catch {
      return undefined;
    }
  }

  private safeLoadSessionMetadata(
    id: string,
  ): { projectId?: string; pinned: boolean } | undefined {
    try {
      return this.store.loadSessionMetadata(id);
    } catch {
      return undefined;
    }
  }

  private async safeDeleteSession(id: string): Promise<boolean> {
    try {
      return await this.store.deleteSession(id);
    } catch {
      return false;
    }
  }

  // Disposes every session so tests (and shutdown) do not leak runs/timers.
  async onModuleDestroy(): Promise<void> {
    await Promise.all([...this.entries.keys()].map((id) => this.dispose(id)));
    await Promise.all(this.advisoryWrites);
  }
}

function sessionTitle(snapshot: SessionSnapshot): string {
  const firstUser = snapshot.history.find((entry) => entry.role === 'user');
  if (!firstUser) {
    return snapshot.cwd ? workspaceName(snapshot.cwd) : snapshot.id;
  }
  const text = messageContentToText(firstUser.content).trim();
  return text.length > 0 ? text.slice(0, 80) : snapshot.id;
}

function workspaceName(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return parts.at(-1) ?? path;
}

function messageContentToText(
  content: SessionSnapshot['history'][number]['content'],
): string {
  if (typeof content === 'string') return content;
  return content
    .map((block) => {
      if (block.type === 'text') return block.text;
      return `[image: ${block.mediaType}]`;
    })
    .join('\n');
}
