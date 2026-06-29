import type { Tool } from "./tool.js";

export class ToolRegistry {
  private readonly toolsByName = new Map<string, Tool>();
  private readonly toolsByAlias = new Map<string, Tool>();

  constructor(tools: Tool[] = []) {
    for (const tool of tools) {
      this.register(tool);
    }
  }

  register(tool: Tool): void {
    if (this.toolsByName.has(tool.name)) {
      throw new Error("Duplicate tool name: " + tool.name);
    }
    if (this.toolsByAlias.has(tool.name)) {
      throw new Error("Tool name conflicts with existing alias: " + tool.name);
    }
    this.toolsByName.set(tool.name, tool);

    for (const alias of tool.aliases ?? []) {
      if (this.toolsByName.has(alias) || this.toolsByAlias.has(alias)) {
        throw new Error("Duplicate tool alias: " + alias);
      }
      this.toolsByAlias.set(alias, tool);
    }
  }

  get(name: string): Tool | undefined {
    return this.toolsByName.get(name) ?? this.toolsByAlias.get(name);
  }

  list(): Tool[] {
    return [...this.toolsByName.values()];
  }
}
