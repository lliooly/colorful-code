import type { ToolResultBlock } from "./tool.js";
import { ToolRunner, type ToolUseRequest } from "./runner.js";

export class ToolScheduler {
  constructor(private readonly runner: ToolRunner) {}

  async runAll(toolUses: ToolUseRequest[]): Promise<ToolResultBlock[]> {
    const results: ToolResultBlock[] = [];
    let index = 0;

    while (index < toolUses.length) {
      const current = toolUses[index]!;
      if (!this.runner.canRunConcurrently(current)) {
        results.push(await this.runner.run(current));
        index += 1;
        continue;
      }

      const batch: ToolUseRequest[] = [];
      while (index < toolUses.length && this.runner.canRunConcurrently(toolUses[index]!)) {
        batch.push(toolUses[index]!);
        index += 1;
      }
      results.push(...(await Promise.all(batch.map((toolUse) => this.runner.run(toolUse)))));
    }

    return results;
  }
}
