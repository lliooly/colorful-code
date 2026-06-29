const VALID_MCP_NAME = /[^a-zA-Z0-9_-]/g;

export function normalizeMcpName(name: string): string {
  return name.replace(VALID_MCP_NAME, '_');
}

export function getMcpToolPrefix(serverName: string): string {
  return 'mcp__' + normalizeMcpName(serverName) + '__';
}

export function buildMcpToolName(serverName: string, toolName: string): string {
  return getMcpToolPrefix(serverName) + normalizeMcpName(toolName);
}
