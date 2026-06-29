import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Sse
} from '@nestjs/common';
import type { MessageEvent } from '@nestjs/common';
import { map, type Observable } from 'rxjs';
import type {
  ControlMessage,
  PermissionBehavior,
  PermissionMode,
  PermissionRule,
  PermissionRuleSource,
  SessionEvent
} from '@colorful-code/tool-runtime';
import {
  SessionsService,
  type CreateSessionOptions
} from './sessions.service';

// ---- Request body shapes (validated by hand to avoid a validation dep) ----

// All fields are untrusted JSON until validated below — typed `unknown` so the
// validators are forced to narrow them.
type CreateSessionBody = {
  permissionMode?: unknown;
  workspaceRoots?: unknown;
  rules?: unknown;
  cwd?: unknown;
};

type MessageBody = {
  text?: unknown;
};

// Mirrors the engine's ControlMessage union as a wire shape; `validateControl`
// narrows an unknown body into a ControlMessage or throws 400.
type ControlBody = Record<string, unknown>;

const PERMISSION_MODES: readonly PermissionMode[] = [
  'default',
  'plan',
  'acceptEdits',
  'readOnly',
  'bypass'
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
      `\`permissionMode\` must be one of: ${PERMISSION_MODES.join(', ')}.`
    );
  }
  return value;
}

const RULE_SOURCES: readonly PermissionRuleSource[] = [
  'userSettings',
  'projectSettings',
  'session',
  'cliArg',
  'policy'
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
      '`workspaceRoots` must be an array of strings.'
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
      ...(raw.argPattern !== undefined ? { argPattern: raw.argPattern } : {})
    };
  });
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
          'approval_response requires a string `requestId`.'
        );
      }
      const decision = body.decision as Record<string, unknown> | undefined;
      if (!decision || typeof decision !== 'object') {
        throw new BadRequestException(
          'approval_response requires a `decision` object.'
        );
      }
      if (decision.behavior === 'allow') {
        // `updatedInput` becomes the tool input directly — the runner does NOT
        // re-parse it against the tool schema — so reject anything that is not a
        // JSON object here before it can reach `tool.call`.
        const updatedInput = decision.updatedInput;
        if (updatedInput !== undefined && !isPlainObject(updatedInput)) {
          throw new BadRequestException(
            'approval_response `decision.updatedInput` must be a JSON object.'
          );
        }
        return {
          type: 'approval_response',
          requestId: body.requestId,
          decision: {
            behavior: 'allow',
            ...(updatedInput !== undefined ? { updatedInput } : {})
          }
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
              : {})
          }
        };
      }
      throw new BadRequestException(
        'approval_response `decision.behavior` must be "allow" or "deny".'
      );
    }
    case 'cancel': {
      return { type: 'cancel' };
    }
    case 'set_permission_mode': {
      if (!isPermissionMode(body.mode)) {
        throw new BadRequestException(
          'set_permission_mode requires a valid `mode`.'
        );
      }
      return { type: 'set_permission_mode', mode: body.mode };
    }
    default:
      throw new BadRequestException(
        `Unsupported control message type: ${String(type)}`
      );
  }
}

@Controller('sessions')
export class SessionsController {
  constructor(private readonly sessions: SessionsService) {}

  // POST /sessions -> create a session (optionally seeding its PermissionContext)
  // and return its id.
  @Post()
  create(@Body() body: CreateSessionBody = {}): { id: string } {
    const permissionMode = validatePermissionMode(body.permissionMode);
    const workspaceRoots = validateWorkspaceRoots(body.workspaceRoots);
    const rules = validateRules(body.rules);
    const options: CreateSessionOptions = {
      ...(permissionMode !== undefined ? { permissionMode } : {}),
      ...(workspaceRoots !== undefined ? { workspaceRoots } : {}),
      ...(rules !== undefined ? { rules } : {}),
      ...(typeof body.cwd === 'string' ? { cwd: body.cwd } : {})
    };
    return this.sessions.create(options);
  }

  // POST /sessions/:id/messages { text } -> submit (fire-and-forget). 202 ack;
  // progress arrives over the SSE stream. 404 if the id is unknown.
  @Post(':id/messages')
  @HttpCode(202)
  message(
    @Param('id') id: string,
    @Body() body: MessageBody
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
    @Body() body: ControlBody
  ): { status: 'accepted' } {
    const message = validateControl(body ?? {});
    this.sessions.sendControl(id, message);
    return { status: 'accepted' };
  }

  // GET /sessions/:id/events -> SSE stream of SessionEvents. Replays the buffered
  // log first, then streams live. Works on Fastify via Nest's @Sse(). 404 if the
  // id is unknown (thrown synchronously before the stream opens).
  @Sse(':id/events')
  events(@Param('id') id: string): Observable<MessageEvent> {
    return this.sessions.events(id).pipe(
      map((event: SessionEvent): MessageEvent => ({
        // `type` doubles as the SSE event name; `data` is the JSON payload.
        type: event.type,
        data: event
      }))
    );
  }

  // DELETE /sessions/:id -> dispose. 404 if unknown.
  @Delete(':id')
  @HttpCode(204)
  remove(@Param('id') id: string): void {
    if (!this.sessions.dispose(id)) {
      throw new NotFoundException(`Unknown session: ${id}`);
    }
  }
}
