import type { ToolResultBlock } from './tool.js';
import { ToolRunner, type ToolUseRequest } from './runner.js';

export type ToolSchedulerHooks = {
  onToolStart?: (toolUse: ToolUseRequest) => void;
  onToolResult?: (result: ToolResultBlock) => void;
};

export class ToolScheduler {
  constructor(private readonly runner: ToolRunner) {}

  async runAll(
    toolUses: ToolUseRequest[],
    hooks: ToolSchedulerHooks = {},
  ): Promise<ToolResultBlock[]> {
    const results: ToolResultBlock[] = [];
    let index = 0;

    while (index < toolUses.length) {
      const current = toolUses[index]!;
      if (!this.runner.canRunConcurrently(current)) {
        hooks.onToolStart?.(current);
        const result = await this.runner.run(current);
        hooks.onToolResult?.(result);
        results.push(result);
        index += 1;
        continue;
      }

      const batch: ToolUseRequest[] = [];
      while (
        index < toolUses.length &&
        this.runner.canRunConcurrently(toolUses[index]!)
      ) {
        batch.push(toolUses[index]!);
        index += 1;
      }
      const batchResults = await Promise.all(
        batch.map((toolUse) => {
          hooks.onToolStart?.(toolUse);
          return this.runner.run(toolUse);
        }),
      );
      for (const result of batchResults) {
        hooks.onToolResult?.(result);
      }
      results.push(...batchResults);
    }

    return results;
  }
}
