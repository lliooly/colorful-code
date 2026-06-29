import type { ToolInputJSONSchema } from './schema.js';
import type { JsonObject, Tool, ToolSource } from './tool.js';

// Serializable, model-facing (and UI-facing) contract for a tool. The model plans
// against descriptors; the runtime executes the tool implementation separately.
export type ToolDescriptor = {
  name: string;
  aliases?: string[];
  description: string;
  searchHint?: string;
  inputSchema: ToolInputJSONSchema;
  source: ToolSource;
  readOnly: boolean;
  destructive: boolean;
  concurrencySafe: boolean;
  enabled: boolean;
};

// Evaluates a disposition predicate against the no-input case. Some predicates assume
// a populated input (e.g. a Bash command string); when that assumption fails on `{}`
// we fall back to the conservative answer rather than letting describe crash.
function disposition(
  predicate: (input: JsonObject) => boolean,
  fallback: boolean,
): boolean {
  try {
    return predicate({});
  } catch {
    return fallback;
  }
}

// The disposition flags describe the tool with no input (`{}`). This is the
// conservative no-input disposition; the runner re-evaluates each predicate with the
// real input on every call. `Tool` is erased to `Tool<JsonObject>` at the registry
// level, so the empty object typechecks here.
export function describeTool(tool: Tool): ToolDescriptor {
  return {
    name: tool.name,
    ...(tool.aliases ? { aliases: tool.aliases } : {}),
    description: tool.description ?? '',
    ...(tool.searchHint ? { searchHint: tool.searchHint } : {}),
    inputSchema: tool.inputJSONSchema ?? tool.inputSchema.jsonSchema,
    source: tool.source ?? 'builtin',
    readOnly: disposition((input) => tool.isReadOnly(input), false),
    destructive: disposition((input) => tool.isDestructive(input), true),
    concurrencySafe: disposition((input) => tool.isConcurrencySafe(input), false),
    enabled: tool.isEnabled(),
  };
}

export function describeTools(tools: Tool[]): ToolDescriptor[] {
  return tools.map((tool) => describeTool(tool));
}
