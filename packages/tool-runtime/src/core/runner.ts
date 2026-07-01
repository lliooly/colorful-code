import { SchemaValidationError } from './schema.js';
import {
  createRuntimeContext,
  toolInvocationSource,
  type JsonObject,
  type RuntimeContext,
  type Tool,
  type ToolResultBlock,
} from './tool.js';
import {
  evaluatePermission,
  isMoreRestrictive,
  type PermissionAuditEntry,
  type PermissionBehavior,
  type PermissionDecisionReason,
  type PermissionResult,
  type PermissionRuleUpdate,
} from './permissions.js';
import type { ToolRegistry } from './registry.js';
import { runHooks } from './hooks.js';
import { classifyBashCommand } from '../tools/bash.js';
import { networkTargetForTool } from '../tools/network.js';
import { resolvePathForPermission } from './permissions.js';

export type ToolUseRequest = {
  id: string;
  name: string;
  input: unknown;
};

function errorResult(toolUseId: string, message: string): ToolResultBlock {
  return { toolUseId, content: message, isError: true };
}

// Carries the merged decision plus the input that travels with an `allow`/`ask`
// (a layer may rewrite the input, e.g. to redact an argument).
type MergedDecision = {
  behavior: PermissionBehavior;
  message?: string;
  reason?: PermissionDecisionReason;
  suggestions?: PermissionRuleUpdate[];
  input: JsonObject;
};

// Folds one layer's verdict into the running decision, keeping the most
// restrictive behaviour (deny > ask > allow). A more-restrictive layer replaces
// the message/reason/suggestions. An equally-ranked layer keeps the running
// behaviour but may fill in a missing reason (so a later, more descriptive
// allow/ask reason surfaces in the audit). Any non-deny layer's `updatedInput`
// carries forward so input rewrites from an allowing layer are preserved.
function mergeDecision(
  current: MergedDecision,
  next: PermissionResult,
): MergedDecision {
  const nextInput =
    (next.behavior === 'deny' ? undefined : next.updatedInput) ?? current.input;
  if (isMoreRestrictive(next.behavior, current.behavior)) {
    return {
      behavior: next.behavior,
      message: next.behavior === 'allow' ? undefined : next.message,
      reason: next.reason,
      suggestions: next.behavior === 'ask' ? next.suggestions : undefined,
      input: nextInput,
    };
  }
  return {
    ...current,
    reason: current.reason ?? next.reason,
    input: nextInput,
  };
}

export class ToolRunner {
  constructor(
    private readonly registry: ToolRegistry,
    private readonly baseContext: RuntimeContext = createRuntimeContext(),
  ) {}

  // Appends a permission decision to `context.permissionAudit` when the caller
  // supplied an audit log. No-op otherwise.
  private recordAudit(
    context: RuntimeContext,
    toolUse: ToolUseRequest,
    input: JsonObject,
    behavior: PermissionBehavior,
    reason?: PermissionDecisionReason,
  ): void {
    if (!context.permissionAudit) {
      return;
    }
    const entry: PermissionAuditEntry = {
      toolUseId: toolUse.id,
      toolName: toolUse.name,
      behavior,
      ...(reason ? { reason } : {}),
      ...this.auditMetadata(context, toolUse.name, input),
      at: Date.now(),
    };
    context.permissionAudit.push(entry);
  }

  private auditMetadata(
    context: RuntimeContext,
    toolName: string,
    input: JsonObject,
  ): Partial<PermissionAuditEntry> {
    const resolvedPath = resolvePathForPermission(input, context.cwd);
    if (toolName === 'Bash' && typeof input.command === 'string') {
      return {
        ...(resolvedPath ? { resolvedPath } : {}),
        commandClassification: classifyBashCommand(input.command),
      };
    }
    if (
      toolName === 'WebFetch' ||
      toolName === 'WebBrowser' ||
      toolName === 'WebSearch'
    ) {
      return {
        ...(resolvedPath ? { resolvedPath } : {}),
        networkTarget: networkTargetForTool(toolName, input, context),
      };
    }
    return resolvedPath ? { resolvedPath } : {};
  }

  private async recheckApprovedInput(
    tool: Tool<JsonObject, unknown>,
    input: JsonObject,
    context: RuntimeContext,
  ): Promise<MergedDecision> {
    let rechecked: MergedDecision = {
      behavior: 'allow',
      input,
    };
    if (context.permissionContext) {
      rechecked = mergeDecision(
        rechecked,
        evaluatePermission(tool, rechecked.input, context),
      );
    }
    if (context.permissionPolicy) {
      rechecked = mergeDecision(
        rechecked,
        await context.permissionPolicy(tool, rechecked.input, context),
      );
    }
    return rechecked;
  }

  canRunConcurrently(toolUse: ToolUseRequest): boolean {
    const tool = this.registry.get(toolUse.name);
    if (!tool || !tool.isEnabled()) {
      return false;
    }
    try {
      const input = tool.inputSchema.parse(toolUse.input);
      return tool.isConcurrencySafe(input);
    } catch {
      return false;
    }
  }

  async run(toolUse: ToolUseRequest): Promise<ToolResultBlock> {
    const tool = this.registry.get(toolUse.name);
    if (!tool || !tool.isEnabled()) {
      return errorResult(toolUse.id, 'No such tool available: ' + toolUse.name);
    }

    // The runtime context is shared across calls so tools can persist session
    // state (todos, tasks, cwd, plan mode, ...) by writing to it directly.
    // toolUseId is set per call and is reliable for serially-scheduled tools;
    // concurrency-safe (read-only) tools run in parallel and must not depend on
    // it. toolNames is refreshed from the live registry so tools such as
    // ToolSearch reflect what is actually registered.
    const runtimeContext = this.baseContext;
    if (!runtimeContext.fileState) runtimeContext.fileState = new Map();
    runtimeContext.toolNames = this.registry
      .list()
      .map((registered) => registered.name);
    runtimeContext.toolUseId = toolUse.id;

    let parsedInput: JsonObject;
    try {
      parsedInput = tool.inputSchema.parse(toolUse.input);
    } catch (error) {
      const message =
        error instanceof SchemaValidationError
          ? error.message
          : 'Invalid input';
      return errorResult(toolUse.id, message);
    }

    const preHook = await runHooks(runtimeContext, {
      event: 'preToolUse',
      tool: tool as Tool,
      toolUseId: toolUse.id,
      input: parsedInput,
    });
    if (preHook.input) {
      try {
        parsedInput = tool.inputSchema.parse(preHook.input);
      } catch (error) {
        const message =
          error instanceof SchemaValidationError
            ? error.message
            : 'Invalid hook-modified input';
        return errorResult(toolUse.id, message);
      }
    }
    if (preHook.action === 'deny') {
      this.recordAudit(runtimeContext, toolUse, parsedInput, 'deny', {
        type: 'hook',
        reason: preHook.message ?? 'preToolUse hook denied the tool.',
      });
      return errorResult(
        toolUse.id,
        preHook.message ?? "Tool '" + tool.name + "' was denied by hook.",
      );
    }
    if (preHook.action === 'ask') {
      this.recordAudit(runtimeContext, toolUse, parsedInput, 'ask', {
        type: 'hook',
        reason: preHook.message ?? 'preToolUse hook requested approval.',
      });
    }

    const validation = await tool.validateInput?.(parsedInput, runtimeContext);
    if (validation && !validation.ok) {
      return errorResult(toolUse.id, validation.message);
    }

    // Layered permission decision: the tool's own `checkPermissions`, then the
    // global `permissionContext` via `evaluatePermission` (if present), then the
    // caller-supplied `permissionPolicy` (if present). Merge most-restrictive-wins
    // (deny > ask > allow), carrying any rewritten input forward.
    const toolDecision = await tool.checkPermissions(
      parsedInput,
      runtimeContext,
    );
    let merged: MergedDecision = {
      behavior: toolDecision.behavior,
      message:
        toolDecision.behavior === 'allow' ? undefined : toolDecision.message,
      reason: toolDecision.reason,
      suggestions:
        toolDecision.behavior === 'ask' ? toolDecision.suggestions : undefined,
      input:
        (toolDecision.behavior === 'deny'
          ? undefined
          : toolDecision.updatedInput) ?? parsedInput,
    };

    if (runtimeContext.permissionContext) {
      merged = mergeDecision(
        merged,
        evaluatePermission(tool as Tool, merged.input, runtimeContext),
      );
    }

    if (runtimeContext.permissionPolicy) {
      const policyDecision = await runtimeContext.permissionPolicy(
        tool,
        merged.input,
        runtimeContext,
      );
      merged = mergeDecision(merged, policyDecision);
    }

    parsedInput = merged.input;

    if (merged.behavior === 'deny') {
      this.recordAudit(runtimeContext, toolUse, parsedInput, 'deny', merged.reason);
      return errorResult(
        toolUse.id,
        merged.message ?? "Tool '" + tool.name + "' was denied by policy.",
      );
    }

    if (merged.behavior === 'ask') {
      if (!runtimeContext.requestApproval) {
        // Headless: no approval port, so an `ask` cannot be satisfied. Deny with
        // a clear message and record the decision as a deny.
        this.recordAudit(runtimeContext, toolUse, parsedInput, 'deny', merged.reason);
        return errorResult(
          toolUse.id,
          (merged.message ?? "Tool '" + tool.name + "' requires approval") +
            ' (no approval handler available; denied).',
        );
      }
      const source = toolInvocationSource(tool as Tool, parsedInput);
      const approvalHook = await runHooks(runtimeContext, {
        event: 'onApprovalRequired',
        tool: tool as Tool,
        toolUseId: toolUse.id,
        input: parsedInput,
      });
      if (approvalHook.input) {
        try {
          parsedInput = tool.inputSchema.parse(approvalHook.input);
        } catch (error) {
          const message =
            error instanceof SchemaValidationError
              ? error.message
              : 'Invalid hook-modified input';
          return errorResult(toolUse.id, message);
        }
      }
      if (approvalHook.action === 'deny') {
        this.recordAudit(runtimeContext, toolUse, parsedInput, 'deny', {
          type: 'hook',
          reason:
            approvalHook.message ?? 'onApprovalRequired hook denied the tool.',
        });
        return errorResult(
          toolUse.id,
          approvalHook.message ?? "Tool '" + tool.name + "' was denied by hook.",
        );
      }
      if (approvalHook.ran && approvalHook.action === 'allow') {
        this.recordAudit(runtimeContext, toolUse, parsedInput, 'allow', {
          type: 'hook',
          reason:
            approvalHook.message ??
            'onApprovalRequired hook approved the tool.',
        });
      } else {
        const response = await runtimeContext.requestApproval({
          toolUseId: toolUse.id,
          toolName: tool.name,
          input: parsedInput,
          message:
            merged.message ?? "Tool '" + tool.name + "' requires approval.",
          ...(source ? { source } : {}),
          ...(merged.suggestions ? { suggestions: merged.suggestions } : {}),
        });
        if (response.behavior === 'deny') {
          this.recordAudit(runtimeContext, toolUse, parsedInput, 'deny', merged.reason);
          return errorResult(
            toolUse.id,
            response.message ?? "Tool '" + tool.name + "' was not approved.",
          );
        }
        if (response.updatedInput !== undefined) {
          // An approval may rewrite the tool input (e.g. an interactive client
          // edits it before approving). That rewrite never passed the initial
          // schema parse, so re-validate it here against the tool schema: an
          // object-shaped but malformed input (missing or wrong-typed fields)
          // must not reach `tool.call`.
          try {
            parsedInput = tool.inputSchema.parse(response.updatedInput);
          } catch (error) {
            const message =
              error instanceof SchemaValidationError
                ? error.message
                : 'Invalid updated input';
            return errorResult(toolUse.id, message);
          }
          const finalDecision = await this.recheckApprovedInput(
            tool as Tool,
            parsedInput,
            runtimeContext,
          );
          parsedInput = finalDecision.input;
          if (finalDecision.behavior === 'deny') {
            this.recordAudit(
              runtimeContext,
              toolUse,
              parsedInput,
              'deny',
              finalDecision.reason ?? merged.reason,
            );
            return errorResult(
              toolUse.id,
              finalDecision.message ??
                "Tool '" + tool.name + "' was denied after approval update.",
            );
          }
          if (finalDecision.behavior === 'ask') {
            this.recordAudit(
              runtimeContext,
              toolUse,
              parsedInput,
              'deny',
              finalDecision.reason ?? merged.reason,
            );
            return errorResult(
              toolUse.id,
              (finalDecision.message ??
                "Tool '" + tool.name + "' requires additional approval") +
                ' after approval update.',
            );
          }
          this.recordAudit(
            runtimeContext,
            toolUse,
            parsedInput,
            'allow',
            finalDecision.reason ?? merged.reason,
          );
        } else {
          this.recordAudit(
            runtimeContext,
            toolUse,
            parsedInput,
            'allow',
            merged.reason,
          );
        }
      }
    } else {
      this.recordAudit(runtimeContext, toolUse, parsedInput, 'allow', merged.reason);
    }

    try {
      const result = await tool.call(parsedInput, runtimeContext);
      await runHooks(runtimeContext, {
        event: 'postToolUse',
        tool: tool as Tool,
        toolUseId: toolUse.id,
        input: parsedInput,
        result: result.data,
      });
      return tool.mapResult(result.data, toolUse.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return errorResult(toolUse.id, message);
    }
  }
}
