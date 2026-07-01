import type { JsonObject, RuntimeContext, Tool } from './tool.js';

export type HookEvent =
  | 'sessionStart'
  | 'beforeModelRun'
  | 'afterModelRun'
  | 'preToolUse'
  | 'postToolUse'
  | 'onApprovalRequired'
  | 'sessionEnd';

export type HookFailurePolicy = 'fail-open' | 'fail-closed';

export type HookResult =
  | { action: 'allow'; message?: string }
  | { action: 'deny'; message: string }
  | { action: 'ask'; message: string }
  | { action: 'modifyInput'; input: JsonObject; message?: string }
  | { action: 'appendContext'; context: string; message?: string };

export type HookInvocation = {
  event: HookEvent;
  context: RuntimeContext;
  tool?: Tool<JsonObject, unknown>;
  toolUseId?: string;
  input?: JsonObject;
  result?: unknown;
  runId?: string;
};

export type RuntimeHook = {
  id: string;
  event: HookEvent;
  run(invocation: HookInvocation): Promise<HookResult | void> | HookResult | void;
};

export type HookConfig = {
  project?: HookConfig;
  user?: HookConfig;
  hooks?: RuntimeHook[];
  allowlist?: string[];
  timeoutMs?: number;
  failurePolicy?: HookFailurePolicy;
};

export type HookAuditEntry = {
  hookId: string;
  event: HookEvent;
  action: HookResult['action'] | 'failure' | 'skipped';
  at: number;
  message?: string;
  durationMs?: number;
  error?: string;
};

export type HookFailure = {
  hookId: string;
  event: HookEvent;
  message: string;
  policy: HookFailurePolicy;
};

export type HookRunOutcome = {
  ran: boolean;
  action: 'allow' | 'deny' | 'ask';
  input?: JsonObject;
  appendedContext: string[];
  message?: string;
  failures: HookFailure[];
};

const DEFAULT_TIMEOUT_MS = 1_000;
const DEFAULT_FAILURE_POLICY: HookFailurePolicy = 'fail-open';

function effectiveConfig(config?: HookConfig): Required<
  Pick<HookConfig, 'hooks' | 'allowlist' | 'timeoutMs' | 'failurePolicy'>
> {
  return {
    hooks: config?.hooks ?? [],
    allowlist: config?.allowlist ?? [],
    timeoutMs: config?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    failurePolicy: config?.failurePolicy ?? DEFAULT_FAILURE_POLICY,
  };
}

export function loadHookConfig(input: {
  project?: HookConfig;
  user?: HookConfig;
}): HookConfig {
  const project = effectiveConfig(input.project);
  const user = effectiveConfig(input.user);
  const allowlist = [...project.allowlist, ...user.allowlist];
  const allowed = new Set(allowlist);
  const hooks = [...project.hooks, ...user.hooks].filter((hook) =>
    allowed.has(hook.id),
  );
  return {
    allowlist,
    hooks,
    timeoutMs: input.user?.timeoutMs ?? input.project?.timeoutMs,
    failurePolicy: input.user?.failurePolicy ?? input.project?.failurePolicy,
  };
}

function pushAudit(context: RuntimeContext, entry: HookAuditEntry): void {
  if (!context.hookAudit) {
    context.hookAudit = [];
  }
  context.hookAudit.push(entry);
  context.emitHookEvent?.(entry, context);
}

async function runWithTimeout(
  hook: RuntimeHook,
  invocation: HookInvocation,
  timeoutMs: number,
): Promise<HookResult | void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      hook.run(invocation),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error('Hook timed out after ' + String(timeoutMs) + 'ms.'));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

export async function runHooks(
  context: RuntimeContext,
  invocation: Omit<HookInvocation, 'context'>,
): Promise<HookRunOutcome> {
  const config = effectiveConfig(context.hookConfig);
  const allowlist = new Set(config.allowlist);
  const hooks = config.hooks.filter(
    (hook) => hook.event === invocation.event && allowlist.has(hook.id),
  );
  const outcome: HookRunOutcome = {
    ran: false,
    action: 'allow',
    input: invocation.input,
    appendedContext: [],
    failures: [],
  };

  for (const hook of hooks) {
    outcome.ran = true;
    const started = Date.now();
    try {
      const result = await runWithTimeout(
        hook,
        { ...invocation, context },
        config.timeoutMs,
      );
      const durationMs = Date.now() - started;
      if (!result) {
        pushAudit(context, {
          hookId: hook.id,
          event: hook.event,
          action: 'allow',
          at: Date.now(),
          durationMs,
        });
        continue;
      }
      pushAudit(context, {
        hookId: hook.id,
        event: hook.event,
        action: result.action,
        at: Date.now(),
        ...(result.message ? { message: result.message } : {}),
        durationMs,
      });
      if (result.action === 'modifyInput') {
        outcome.input = result.input;
      } else if (result.action === 'appendContext') {
        outcome.appendedContext.push(result.context);
      } else if (result.action === 'deny' || result.action === 'ask') {
        outcome.action = result.action;
        outcome.message = result.message;
        return outcome;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failure: HookFailure = {
        hookId: hook.id,
        event: hook.event,
        message,
        policy: config.failurePolicy,
      };
      outcome.failures.push(failure);
      context.emitHookFailure?.(failure, context);
      pushAudit(context, {
        hookId: hook.id,
        event: hook.event,
        action: 'failure',
        at: Date.now(),
        error: message,
        durationMs: Date.now() - started,
      });
      if (config.failurePolicy === 'fail-closed') {
        outcome.action = 'deny';
        outcome.message = message;
        return outcome;
      }
    }
  }

  return outcome;
}
