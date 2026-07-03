import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Sse,
} from '@nestjs/common';
import type { MessageEvent } from '@nestjs/common';
import { map, type Observable } from 'rxjs';
import type {
  ControlMessage,
  Checkpoint,
  PermissionAuditEntry,
  PermissionBehavior,
  PermissionMode,
  PermissionRule,
  PermissionRuleSource,
  SessionEvent,
  SessionSnapshot,
} from '@colorful-code/tool-runtime';
import {
  SessionsService,
  type CreateSessionOptions,
  type CreateSessionResponse,
  type GroupedSessionHistory,
  type RestoreCheckpointResponse,
  type RestoreSessionOptions,
  type RestoreSessionResponse,
  type SessionSummary,
} from './sessions.service';
import {
  validateVoiceAudioChunk,
  validateVoiceStartOptions,
} from './voice-transcription';
import type { ModelSelection } from './model-factory';
import {
  validateMcpServersConfig,
  type McpServersConfig,
} from '../config/mcp-config';
import {
  validateLspServersConfig,
  type LspServersConfig,
} from '../config/lsp-config';

// ---- Request body shapes (validated by hand to avoid a validation dep) ----

// All fields are untrusted JSON until validated below — typed `unknown` so the
// validators are forced to narrow them.
type CreateSessionBody = {
  projectId?: unknown;
  permissionMode?: unknown;
  workspaceRoots?: unknown;
  rules?: unknown;
  cwd?: unknown;
  model?: unknown;
  mcpServers?: unknown;
  lspServers?: unknown;
  watchWorkspace?: unknown;
};

type RestoreSessionBody = {
  model?: unknown;
  mcpServers?: unknown;
  lspServers?: unknown;
  watchWorkspace?: unknown;
};

type ConfigureModelBody = {
  model?: unknown;
};

type MessageBody = {
  text?: unknown;
};

type VoiceStartBody = {
  requestId?: unknown;
  apiKey?: unknown;
  model?: unknown;
  language?: unknown;
};

type VoiceAudioBody = {
  audio?: unknown;
  sampleRate?: unknown;
  numChannels?: unknown;
};

type PatchSessionBody = {
  pinned?: unknown;
};

// Mirrors the engine's ControlMessage union as a wire shape; `validateControl`
// narrows an unknown body into a ControlMessage or throws 400.
type ControlBody = Record<string, unknown>;

const PERMISSION_MODES: readonly PermissionMode[] = [
  'default',
  'plan',
  'acceptEdits',
  'readOnly',
  'bypass',
];

function isPermissionMode(value: unknown): value is PermissionMode {
  return (
    typeof value === 'string' &&
    (PERMISSION_MODES as readonly string[]).includes(value)
  );
}

// Validates `permissionMode` from a create-session body: undefined (use the
// engine default), or a valid mode. A present-but-invalid mode is a 400 — a
// silent fallback to `default` could hand back a LESS restrictive session than
// the client asked for (e.g. a `readOnlyy` typo). Mirrors set_permission_mode.
function validatePermissionMode(value: unknown): PermissionMode | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isPermissionMode(value)) {
    throw new BadRequestException(
      `\`permissionMode\` must be one of: ${PERMISSION_MODES.join(', ')}.`,
    );
  }
  return value;
}

const RULE_SOURCES: readonly PermissionRuleSource[] = [
  'userSettings',
  'projectSettings',
  'session',
  'cliArg',
  'policy',
];

const RULE_BEHAVIORS: readonly PermissionBehavior[] = ['allow', 'deny', 'ask'];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Validates `workspaceRoots` from a create-session body: undefined, or an array
// of strings. A non-string root is rejected here (400) because it can otherwise
// throw during path resolution in acceptEdits mode rather than fail cleanly.
function validateWorkspaceRoots(value: unknown): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.some((root) => typeof root !== 'string')) {
    throw new BadRequestException(
      '`workspaceRoots` must be an array of strings.',
    );
  }
  return [...(value as string[])];
}

// Validates `rules` from a create-session body into well-formed PermissionRules:
// each needs a known source + behavior, a string toolName, and an optional
// string argPattern. Malformed rules are rejected (400) before they reach
// permission evaluation.
function validateRules(value: unknown): PermissionRule[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new BadRequestException('`rules` must be an array.');
  }
  return value.map((raw, index): PermissionRule => {
    const at = `rules[${String(index)}]`;
    if (!isPlainObject(raw)) {
      throw new BadRequestException(`\`${at}\` must be an object.`);
    }
    if (!(RULE_SOURCES as readonly string[]).includes(raw.source as string)) {
      throw new BadRequestException(`\`${at}.source\` is invalid.`);
    }
    if (
      !(RULE_BEHAVIORS as readonly string[]).includes(raw.behavior as string)
    ) {
      throw new BadRequestException(`\`${at}.behavior\` is invalid.`);
    }
    if (typeof raw.toolName !== 'string') {
      throw new BadRequestException(`\`${at}.toolName\` must be a string.`);
    }
    if (raw.argPattern !== undefined && typeof raw.argPattern !== 'string') {
      throw new BadRequestException(`\`${at}.argPattern\` must be a string.`);
    }
    return {
      source: raw.source as PermissionRuleSource,
      behavior: raw.behavior as PermissionBehavior,
      toolName: raw.toolName,
      ...(raw.argPattern !== undefined ? { argPattern: raw.argPattern } : {}),
    };
  });
}

const MODEL_PROTOCOLS = ['anthropic', 'openai'] as const;

function isModelProtocol(
  value: unknown,
): value is (typeof MODEL_PROTOCOLS)[number] {
  return (
    typeof value === 'string' &&
    (MODEL_PROTOCOLS as readonly string[]).includes(value)
  );
}

// Validates the optional `model` selection from a create-session body into a
// well-formed ModelSelection (wire-shape only). Preset existence and provider-key
// availability are resolved server-side at session create and surface as a 400
// from the service — they are NOT re-checked here (the controller has no
// environment). A present-but-malformed field is a 400 so a typo fails loudly.
export function validateModelSelection(
  value: unknown,
): ModelSelection | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isPlainObject(value)) {
    throw new BadRequestException('`model` must be an object.');
  }

  const selection: ModelSelection = {};

  if (value.preset !== undefined) {
    if (typeof value.preset !== 'string') {
      throw new BadRequestException('`model.preset` must be a string.');
    }
    selection.preset = value.preset;
  }
  if (value.protocol !== undefined) {
    if (!isModelProtocol(value.protocol)) {
      throw new BadRequestException(
        "`model.protocol` must be 'anthropic' or 'openai'.",
      );
    }
    selection.protocol = value.protocol;
  }
  if (value.model !== undefined) {
    if (typeof value.model !== 'string') {
      throw new BadRequestException('`model.model` must be a string.');
    }
    selection.model = value.model;
  }
  if (value.baseURL !== undefined) {
    if (typeof value.baseURL !== 'string') {
      throw new BadRequestException('`model.baseURL` must be a string.');
    }
    selection.baseURL = value.baseURL;
  }
  if (value.apiKey !== undefined) {
    if (typeof value.apiKey !== 'string') {
      throw new BadRequestException('`model.apiKey` must be a string.');
    }
    selection.apiKey = value.apiKey;
  }
  if (value.maxTokens !== undefined) {
    if (
      typeof value.maxTokens !== 'number' ||
      !Number.isInteger(value.maxTokens)
    ) {
      throw new BadRequestException('`model.maxTokens` must be an integer.');
    }
    selection.maxTokens = value.maxTokens;
  }
  if (value.temperature !== undefined) {
    if (typeof value.temperature !== 'number') {
      throw new BadRequestException('`model.temperature` must be a number.');
    }
    selection.temperature = value.temperature;
  }
  if (value.thinking !== undefined) {
    if (value.thinking !== 'adaptive' && value.thinking !== 'disabled') {
      throw new BadRequestException(
        "`model.thinking` must be 'adaptive' or 'disabled'.",
      );
    }
    selection.thinking = value.thinking;
  }

  return selection;
}

function validateMcpServers(value: unknown): McpServersConfig | undefined {
  if (value === undefined) {
    return undefined;
  }
  try {
    return validateMcpServersConfig(value);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new BadRequestException(message);
  }
}

function validateLspServers(value: unknown): LspServersConfig | undefined {
  if (value === undefined) {
    return undefined;
  }
  try {
    return validateLspServersConfig(value);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new BadRequestException(message);
  }
}

function validateWatchWorkspace(value: unknown): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'boolean') {
    throw new BadRequestException('`watchWorkspace` must be a boolean.');
  }
  return value;
}

function validateProjectId(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new BadRequestException('`projectId` must be a non-empty string.');
  }
  return value;
}

function validatePinned(value: unknown): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'boolean') {
    throw new BadRequestException('`pinned` must be a boolean.');
  }
  return value;
}

function validateRequestId(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new BadRequestException('voice transcription requires `requestId`.');
  }
  return value;
}

// Validates and narrows an arbitrary control body into a ControlMessage. Throws
// BadRequestException (400) on anything malformed so a bad client cannot push an
// ill-formed message into the engine.
function validateControl(body: ControlBody): ControlMessage {
  const type = body.type;
  switch (type) {
    case 'user_message': {
      if (typeof body.text !== 'string') {
        throw new BadRequestException('user_message requires a string `text`.');
      }
      return { type: 'user_message', text: body.text };
    }
    case 'approval_response': {
      if (typeof body.requestId !== 'string') {
        throw new BadRequestException(
          'approval_response requires a string `requestId`.',
        );
      }
      const decision = body.decision as Record<string, unknown> | undefined;
      if (!decision || typeof decision !== 'object') {
        throw new BadRequestException(
          'approval_response requires a `decision` object.',
        );
      }
      if (decision.behavior === 'allow') {
        // `updatedInput` becomes the tool input directly — the runner does NOT
        // re-parse it against the tool schema — so reject anything that is not a
        // JSON object here before it can reach `tool.call`.
        const updatedInput = decision.updatedInput;
        if (updatedInput !== undefined && !isPlainObject(updatedInput)) {
          throw new BadRequestException(
            'approval_response `decision.updatedInput` must be a JSON object.',
          );
        }
        return {
          type: 'approval_response',
          requestId: body.requestId,
          decision: {
            behavior: 'allow',
            ...(updatedInput !== undefined ? { updatedInput } : {}),
          },
        };
      }
      if (decision.behavior === 'deny') {
        return {
          type: 'approval_response',
          requestId: body.requestId,
          decision: {
            behavior: 'deny',
            ...(typeof decision.message === 'string'
              ? { message: decision.message }
              : {}),
          },
        };
      }
      throw new BadRequestException(
        'approval_response `decision.behavior` must be "allow" or "deny".',
      );
    }
    case 'edit_decision': {
      if (typeof body.proposalId !== 'string') {
        throw new BadRequestException(
          'edit_decision requires a string `proposalId`.',
        );
      }
      if (body.decision !== 'approve' && body.decision !== 'reject') {
        throw new BadRequestException(
          'edit_decision `decision` must be "approve" or "reject".',
        );
      }
      return {
        type: 'edit_decision',
        proposalId: body.proposalId,
        decision: body.decision,
        ...(typeof body.reason === 'string' ? { reason: body.reason } : {}),
      };
    }
    case 'cancel': {
      return { type: 'cancel' };
    }
    case 'compact': {
      return { type: 'compact' };
    }
    case 'set_permission_mode': {
      if (!isPermissionMode(body.mode)) {
        throw new BadRequestException(
          'set_permission_mode requires a valid `mode`.',
        );
      }
      return { type: 'set_permission_mode', mode: body.mode };
    }
    default:
      throw new BadRequestException(
        `Unsupported control message type: ${String(type)}`,
      );
  }
}

@Controller('sessions')
export class SessionsController {
  constructor(private readonly sessions: SessionsService) {}

  @Get()
  list(): GroupedSessionHistory {
    return this.sessions.listSessions();
  }

  // POST /sessions -> create a session (optionally seeding its PermissionContext)
  // and return its id + needsModelConfig flag.
  @Post()
  async create(
    @Body() body: CreateSessionBody = {},
  ): Promise<CreateSessionResponse> {
    const projectId = validateProjectId(body.projectId);
    const permissionMode = validatePermissionMode(body.permissionMode);
    const workspaceRoots = validateWorkspaceRoots(body.workspaceRoots);
    const rules = validateRules(body.rules);
    const model = validateModelSelection(body.model);
    const mcpServers = validateMcpServers(body.mcpServers);
    const lspServers = validateLspServers(body.lspServers);
    const watchWorkspace = validateWatchWorkspace(body.watchWorkspace);
    const options: CreateSessionOptions = {
      ...(projectId !== undefined ? { projectId } : {}),
      ...(permissionMode !== undefined ? { permissionMode } : {}),
      ...(workspaceRoots !== undefined ? { workspaceRoots } : {}),
      ...(rules !== undefined ? { rules } : {}),
      ...(typeof body.cwd === 'string' ? { cwd: body.cwd } : {}),
      ...(model !== undefined ? { model } : {}),
      ...(mcpServers !== undefined ? { mcpServers } : {}),
      ...(lspServers !== undefined ? { lspServers } : {}),
      ...(watchWorkspace !== undefined ? { watchWorkspace } : {}),
    };
    return await this.sessions.create(options);
  }

  @Patch(':id')
  patch(
    @Param('id') id: string,
    @Body() body: PatchSessionBody = {},
  ): SessionSummary {
    const pinned = validatePinned(body.pinned);
    return this.sessions.updateSession(id, {
      ...(pinned !== undefined ? { pinned } : {}),
    });
  }

  // POST /sessions/:id/restore -> restore a disposed/non-live session from its
  // persisted snapshot. The snapshot does not contain secrets; if a client needs
  // a custom model key it can provide a fresh `model` selection here. If the
  // session is already live, the service returns that existing live session id.
  @Post(':id/restore')
  restore(
    @Param('id') id: string,
    @Body() body: RestoreSessionBody = {},
  ): Promise<RestoreSessionResponse> {
    const model = validateModelSelection(body.model);
    const mcpServers = validateMcpServers(body.mcpServers);
    const lspServers = validateLspServers(body.lspServers);
    const watchWorkspace = validateWatchWorkspace(body.watchWorkspace);
    const options: RestoreSessionOptions = {
      ...(model !== undefined ? { model } : {}),
      ...(mcpServers !== undefined ? { mcpServers } : {}),
      ...(lspServers !== undefined ? { lspServers } : {}),
      ...(watchWorkspace !== undefined ? { watchWorkspace } : {}),
    };
    return this.sessions.restore(id, options);
  }

  // POST /sessions/:id/messages { text } -> submit (fire-and-forget). 202 ack;
  // progress arrives over the SSE stream. 404 if the id is unknown.
  @Post(':id/messages')
  @HttpCode(202)
  message(
    @Param('id') id: string,
    @Body() body: MessageBody,
  ): { status: 'accepted' } {
    if (typeof body?.text !== 'string') {
      throw new BadRequestException('messages requires a string `text`.');
    }
    this.sessions.submit(id, body.text);
    return { status: 'accepted' };
  }

  // POST /sessions/:id/control -> validate + route a control message. 404 if the
  // id is unknown, 400 if the message is malformed.
  @Post(':id/control')
  @HttpCode(202)
  control(
    @Param('id') id: string,
    @Body() body: ControlBody,
  ): { status: 'accepted' } {
    const message = validateControl(body ?? {});
    this.sessions.sendControl(id, message);
    return { status: 'accepted' };
  }

  @Post(':id/voice/start')
  @HttpCode(202)
  voiceStart(
    @Param('id') id: string,
    @Body() body: VoiceStartBody = {},
  ): { status: 'accepted' } {
    const requestId = validateRequestId(body.requestId);
    this.sessions.startVoiceTranscription(
      id,
      requestId,
      validateVoiceStartOptions(body),
    );
    return { status: 'accepted' };
  }

  @Post(':id/voice/audio')
  @HttpCode(202)
  voiceAudio(
    @Param('id') id: string,
    @Body() body: VoiceAudioBody,
  ): { status: 'accepted' } {
    this.sessions.appendVoiceAudio(id, validateVoiceAudioChunk(body));
    return { status: 'accepted' };
  }

  @Post(':id/voice/stop')
  @HttpCode(202)
  voiceStop(@Param('id') id: string): { status: 'accepted' } {
    this.sessions.stopVoiceTranscription(id);
    return { status: 'accepted' };
  }

  // GET /sessions/:id/events -> SSE stream of SessionEvents. Replays the buffered
  // log first, then streams live. Works on Fastify via Nest's @Sse(). 404 if the
  // id is unknown (thrown synchronously before the stream opens).
  @Sse(':id/events')
  events(@Param('id') id: string): Observable<MessageEvent> {
    return this.sessions.events(id).pipe(
      map(
        (event: SessionEvent): MessageEvent => ({
          // `type` doubles as the SSE event name; `data` is the JSON payload.
          type: event.type,
          data: event,
        }),
      ),
    );
  }

  // GET /sessions/:id/snapshot -> the persisted SessionSnapshot for this id, or
  // 404 if nothing was ever persisted. Reads from the store, so it works for a
  // session that has already been disposed from memory. The snapshot carries no
  // secret (the engine excludes the apiKey).
  @Get(':id/snapshot')
  snapshot(@Param('id') id: string): SessionSnapshot {
    const snapshot = this.sessions.loadSnapshot(id);
    if (!snapshot) {
      throw new NotFoundException(`No persisted snapshot for session: ${id}`);
    }
    return snapshot;
  }

  // GET /sessions/:id/audit -> the persisted permission-audit trail for this id
  // (insertion order). Empty array when there is none — an absent trail is not a
  // 404 here (a session may simply have made no audited decisions).
  @Get(':id/audit')
  audit(@Param('id') id: string): { entries: PermissionAuditEntry[] } {
    return { entries: this.sessions.loadAudit(id) };
  }

  @Get(':id/checkpoints')
  checkpoints(@Param('id') id: string): {
    checkpoints: Checkpoint[];
    currentCheckpointId?: string;
  } {
    return this.sessions.listCheckpoints(id);
  }

  @Post(':id/checkpoints/:checkpointId/restore')
  restoreCheckpoint(
    @Param('id') id: string,
    @Param('checkpointId') checkpointId: string,
    @Body() body: RestoreSessionBody = {},
  ): Promise<RestoreCheckpointResponse> {
    const model = validateModelSelection(body.model);
    const mcpServers = validateMcpServers(body.mcpServers);
    const lspServers = validateLspServers(body.lspServers);
    const watchWorkspace = validateWatchWorkspace(body.watchWorkspace);
    const options: RestoreSessionOptions = {
      ...(model !== undefined ? { model } : {}),
      ...(mcpServers !== undefined ? { mcpServers } : {}),
      ...(lspServers !== undefined ? { lspServers } : {}),
      ...(watchWorkspace !== undefined ? { watchWorkspace } : {}),
    };
    return this.sessions.restoreCheckpoint(id, checkpointId, options);
  }

  @Post(':id/checkpoints/:checkpointId/fork')
  forkCheckpoint(
    @Param('id') id: string,
    @Param('checkpointId') checkpointId: string,
    @Body() body: RestoreSessionBody = {},
  ): Promise<RestoreCheckpointResponse> {
    const model = validateModelSelection(body.model);
    const mcpServers = validateMcpServers(body.mcpServers);
    const lspServers = validateLspServers(body.lspServers);
    const watchWorkspace = validateWatchWorkspace(body.watchWorkspace);
    const options: RestoreSessionOptions = {
      ...(model !== undefined ? { model } : {}),
      ...(mcpServers !== undefined ? { mcpServers } : {}),
      ...(lspServers !== undefined ? { lspServers } : {}),
      ...(watchWorkspace !== undefined ? { watchWorkspace } : {}),
    };
    return this.sessions.forkCheckpoint(id, checkpointId, options);
  }

  // POST /sessions/:id/configure-model -> update or upgrade the model for a live
  // session. Used after the user sets an API key so the session can start running
  // turns without a full restore.
  @Post(':id/configure-model')
  configureModel(
    @Param('id') id: string,
    @Body() body: ConfigureModelBody = {},
  ): { needsModelConfig: boolean } {
    const model = validateModelSelection(body.model);
    if (!model) {
      throw new BadRequestException(
        '`model` is required when configuring a session model.',
      );
    }
    return this.sessions.configureModel(id, model);
  }

  @Delete()
  @HttpCode(204)
  async clear(
    @Query('scope') scope?: string,
    @Query('projectId') projectId?: string,
  ): Promise<void> {
    if (scope !== undefined && scope !== 'standalone') {
      throw new BadRequestException('`scope` must be `standalone`.');
    }
    if (scope === 'standalone' && projectId !== undefined) {
      throw new BadRequestException(
        '`scope=standalone` cannot be combined with `projectId`.',
      );
    }
    await this.sessions.clearSessions({
      ...(scope === 'standalone' ? { standalone: true } : {}),
      ...(projectId !== undefined ? { projectId } : {}),
    });
  }

  // DELETE /sessions/:id -> hard delete. 404 if unknown.
  @Delete(':id')
  @HttpCode(204)
  async remove(@Param('id') id: string): Promise<void> {
    if (!(await this.sessions.deleteSession(id))) {
      throw new NotFoundException(`Unknown session: ${id}`);
    }
  }
}
