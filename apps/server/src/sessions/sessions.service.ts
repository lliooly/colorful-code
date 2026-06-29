import {
  Inject,
  Injectable,
  NotFoundException,
  OnModuleDestroy
} from '@nestjs/common';
import { Observable } from 'rxjs';
import {
  createBuiltinTools,
  Session,
  type ControlMessage,
  type PermissionContext,
  type PermissionMode,
  type PermissionRule,
  type SessionEvent
} from '@colorful-code/tool-runtime';
import {
  MODEL_CLIENT_FACTORY,
  type ModelClientFactory
} from './model-factory';

// Options accepted by `POST /sessions` to seed a session's PermissionContext.
export type CreateSessionOptions = {
  permissionMode?: PermissionMode;
  workspaceRoots?: string[];
  rules?: PermissionRule[];
  cwd?: string;
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
};

@Injectable()
export class SessionsService implements OnModuleDestroy {
  private readonly entries = new Map<string, SessionEntry>();

  constructor(
    @Inject(MODEL_CLIENT_FACTORY)
    private readonly modelClientFactory: ModelClientFactory
  ) {}

  // Builds a fresh PermissionContext from the request options. `workspaceRoots`
  // falls back to `[cwd]` when a cwd is supplied (mirrors the engine default).
  private buildPermissionContext(
    options: CreateSessionOptions
  ): PermissionContext {
    const workspaceRoots =
      options.workspaceRoots ?? (options.cwd ? [options.cwd] : []);
    return {
      mode: options.permissionMode ?? 'default',
      workspaceRoots: [...workspaceRoots],
      rules: options.rules ? [...options.rules] : []
    };
  }

  // Creates a session, wires its event subscription to the replay buffer + live
  // listeners, and registers it. The model client is built per session via the
  // injected factory; tools are the built-ins.
  create(options: CreateSessionOptions = {}): { id: string } {
    const permissionContext = this.buildPermissionContext(options);

    // Mint the id up front so the factory can key on it if needed.
    const id = `session-${String(Date.now())}-${String(this.entries.size + 1)}`;

    const session = new Session({
      id,
      model: this.modelClientFactory({ sessionId: id }),
      tools: createBuiltinTools(),
      ...(options.cwd ? { cwd: options.cwd } : {}),
      permissionContext
    });

    const log: SessionEvent[] = [];
    const listeners = new Set<(event: SessionEvent) => void>();

    const unsubscribe = session.subscribe((event) => {
      // Buffer first (so late subscribers replay it), then fan out live.
      log.push(event);
      for (const listener of listeners) {
        listener(event);
      }
    });

    this.entries.set(id, { session, log, listeners, unsubscribe });
    return { id };
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
  dispose(id: string): boolean {
    const entry = this.entries.get(id);
    if (!entry) {
      return false;
    }
    entry.session.send({ type: 'cancel' });
    entry.unsubscribe();
    entry.listeners.clear();
    this.entries.delete(id);
    return true;
  }

  // Disposes every session so tests (and shutdown) do not leak runs/timers.
  onModuleDestroy(): void {
    for (const id of [...this.entries.keys()]) {
      this.dispose(id);
    }
  }
}
