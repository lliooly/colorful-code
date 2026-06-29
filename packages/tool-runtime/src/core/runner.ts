import { SchemaValidationError } from "./schema.js";
import {
  createRuntimeContext,
  type JsonObject,
  type RuntimeContext,
  type ToolResultBlock,
} from "./tool.js";
import type { ToolRegistry } from "./registry.js";

export type ToolUseRequest = {
  id: string;
  name: string;
  input: unknown;
};

function errorResult(toolUseId: string, message: string): ToolResultBlock {
  return { toolUseId, content: message, isError: true };
}

export class ToolRunner {
  constructor(
    private readonly registry: ToolRegistry,
    private readonly baseContext: RuntimeContext = createRuntimeContext(),
  ) {}

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
      return errorResult(toolUse.id, "No such tool available: " + toolUse.name);
    }

    // The runtime context is shared across calls so tools can persist session
    // state (todos, tasks, cwd, plan mode, ...) by writing to it directly.
    // toolUseId is set per call and is reliable for serially-scheduled tools;
    // concurrency-safe (read-only) tools run in parallel and must not depend on
    // it. toolNames is refreshed from the live registry so tools such as
    // ToolSearch reflect what is actually registered.
    const runtimeContext = this.baseContext;
    if (!runtimeContext.fileState) runtimeContext.fileState = new Map();
    runtimeContext.toolNames = this.registry.list().map((registered) => registered.name);
    runtimeContext.toolUseId = toolUse.id;

    let parsedInput: JsonObject;
    try {
      parsedInput = tool.inputSchema.parse(toolUse.input);
    } catch (error) {
      const message = error instanceof SchemaValidationError ? error.message : "Invalid input";
      return errorResult(toolUse.id, message);
    }

    const validation = await tool.validateInput?.(parsedInput, runtimeContext);
    if (validation && !validation.ok) {
      return errorResult(toolUse.id, validation.message);
    }

    const toolDecision = await tool.checkPermissions(parsedInput, runtimeContext);
    if (toolDecision.behavior === "deny") {
      return errorResult(toolUse.id, toolDecision.message);
    }

    parsedInput = toolDecision.updatedInput ?? parsedInput;

    if (runtimeContext.permissionPolicy) {
      const policyDecision = await runtimeContext.permissionPolicy(tool, parsedInput, runtimeContext);
      if (policyDecision.behavior === "deny") {
        return errorResult(toolUse.id, policyDecision.message);
      }
      parsedInput = policyDecision.updatedInput ?? parsedInput;
    }

    try {
      const result = await tool.call(parsedInput, runtimeContext);
      return tool.mapResult(result.data, toolUse.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return errorResult(toolUse.id, message);
    }
  }
}
