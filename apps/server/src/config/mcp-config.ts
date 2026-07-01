import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type {
  McpServerConfig,
  McpTrustLevel,
} from '@colorful-code/tool-runtime';

export type McpServerConfigWithTrust = McpServerConfig & {
  trust?: McpTrustLevel;
};

export type McpServersConfig = Record<string, McpServerConfigWithTrust>;

const TRUST_LEVELS: readonly McpTrustLevel[] = ['trusted', 'ask', 'blocked'];
const PROJECT_MCP_CONFIG_FILES = [
  join('.colorful-code', 'mcp.json'),
  'colorful-code.mcp.json',
  '.mcp.json',
];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateStringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`\`${path}\` must be an array of strings.`);
  }
  return [...value];
}

function validateStringRecord(
  value: unknown,
  path: string,
): Record<string, string> {
  if (!isPlainObject(value)) {
    throw new Error(`\`${path}\` must be an object.`);
  }
  const record: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'string') {
      throw new Error(`\`${path}.${key}\` must be a string.`);
    }
    record[key] = item;
  }
  return record;
}

function validateTrust(
  value: unknown,
  path: string,
): McpTrustLevel | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (
    typeof value !== 'string' ||
    !(TRUST_LEVELS as readonly string[]).includes(value)
  ) {
    throw new Error(`\`${path}\` must be trusted, ask, or blocked.`);
  }
  return value as McpTrustLevel;
}

function validateServerConfig(
  value: unknown,
  path: string,
): McpServerConfigWithTrust {
  if (!isPlainObject(value)) {
    throw new Error(`\`${path}\` must be an object.`);
  }

  const trust = validateTrust(value.trust, `${path}.trust`);
  const type = value.type ?? 'stdio';

  if (type === 'stdio') {
    if (
      typeof value.command !== 'string' ||
      value.command.trim().length === 0
    ) {
      throw new Error(`\`${path}.command\` must be a non-empty string.`);
    }
    return {
      type: 'stdio',
      command: value.command,
      ...(value.args !== undefined
        ? { args: validateStringArray(value.args, `${path}.args`) }
        : {}),
      ...(value.env !== undefined
        ? { env: validateStringRecord(value.env, `${path}.env`) }
        : {}),
      ...(trust ? { trust } : {}),
    };
  }

  if (type === 'http' || type === 'sse') {
    if (typeof value.url !== 'string' || value.url.trim().length === 0) {
      throw new Error(`\`${path}.url\` must be a non-empty string.`);
    }
    try {
      new URL(value.url);
    } catch {
      throw new Error(`\`${path}.url\` must be an absolute URL.`);
    }
    return {
      type,
      url: value.url,
      ...(value.headers !== undefined
        ? { headers: validateStringRecord(value.headers, `${path}.headers`) }
        : {}),
      ...(trust ? { trust } : {}),
    };
  }

  throw new Error(`\`${path}.type\` must be stdio, http, or sse.`);
}

export function validateMcpServersConfig(
  value: unknown,
  path = 'mcpServers',
): McpServersConfig {
  if (!isPlainObject(value)) {
    throw new Error(`\`${path}\` must be an object.`);
  }
  const result: McpServersConfig = {};
  for (const [name, config] of Object.entries(value)) {
    if (!name.trim()) {
      throw new Error(`\`${path}\` contains an empty server name.`);
    }
    result[name] = validateServerConfig(config, `${path}.${name}`);
  }
  return result;
}

export function parseMcpConfigDocument(
  value: unknown,
  path = 'mcpConfig',
): McpServersConfig {
  if (!isPlainObject(value)) {
    throw new Error(`\`${path}\` must be an object.`);
  }
  if ('mcpServers' in value) {
    return validateMcpServersConfig(value.mcpServers, `${path}.mcpServers`);
  }
  return validateMcpServersConfig(value, path);
}

export function loadMcpConfigFile(filePath: string): McpServersConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read MCP config ${filePath}: ${message}`);
  }
  return parseMcpConfigDocument(parsed, filePath);
}

export function loadMcpServersFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): McpServersConfig {
  return mergeMcpServers(
    env.MCP_CONFIG ? loadMcpConfigFile(env.MCP_CONFIG) : undefined,
    env.MCP_SERVERS
      ? parseMcpConfigDocument(JSON.parse(env.MCP_SERVERS), 'MCP_SERVERS')
      : undefined,
  );
}

export function loadProjectMcpServers(
  cwd: string | undefined,
): McpServersConfig {
  if (!cwd) {
    return {};
  }
  const configs: McpServersConfig[] = [];
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    for (const relative of PROJECT_MCP_CONFIG_FILES) {
      const filePath = join(dir, relative);
      if (!existsSync(filePath)) {
        continue;
      }
      try {
        if (statSync(filePath).isFile()) {
          configs.push(loadMcpConfigFile(filePath));
        }
      } catch (error) {
        if (error instanceof Error) {
          throw error;
        }
        throw new Error(String(error));
      }
    }
    const parent = dirname(dir);
    if (parent === dir) {
      break;
    }
  }
  return mergeMcpServers(...configs.reverse());
}

export function mergeMcpServers(
  ...configs: Array<McpServersConfig | undefined>
): McpServersConfig {
  return Object.assign({}, ...configs.filter(Boolean));
}
