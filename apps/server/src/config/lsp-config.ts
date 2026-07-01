import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { JsonObject, LspServerConfig } from '@colorful-code/tool-runtime';

export type LspServersConfig = Record<string, LspServerConfig>;

const PROJECT_LSP_CONFIG_FILES = [
  join('.colorful-code', 'lsp.json'),
  'colorful-code.lsp.json',
  '.lsp.json',
];

type AutoDetectOptions = {
  which?: (command: string) => string | undefined;
};

function defaultWhich(command: string): string | undefined {
  try {
    return execFileSync('which', [command], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return undefined;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateStringArray(value: unknown, path: string): string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((item) => typeof item !== 'string' || item.length === 0)
  ) {
    throw new Error(`\`${path}\` must be a non-empty array of strings.`);
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

function validateJsonObject(value: unknown, path: string): JsonObject {
  if (!isPlainObject(value)) {
    throw new Error(`\`${path}\` must be an object.`);
  }
  return { ...value };
}

function validateServerConfig(
  value: unknown,
  path: string,
): LspServerConfig {
  if (!isPlainObject(value)) {
    throw new Error(`\`${path}\` must be an object.`);
  }
  if (typeof value.command !== 'string' || value.command.trim().length === 0) {
    throw new Error(`\`${path}.command\` must be a non-empty string.`);
  }
  if (typeof value.language !== 'string' || value.language.trim().length === 0) {
    throw new Error(`\`${path}.language\` must be a non-empty string.`);
  }
  return {
    command: value.command,
    ...(value.args !== undefined
      ? { args: validateStringArray(value.args, `${path}.args`) }
      : {}),
    ...(value.env !== undefined
      ? { env: validateStringRecord(value.env, `${path}.env`) }
      : {}),
    language: value.language,
    fileExtensions: validateStringArray(
      value.fileExtensions,
      `${path}.fileExtensions`,
    ),
    ...(value.initializationOptions !== undefined
      ? {
          initializationOptions: validateJsonObject(
            value.initializationOptions,
            `${path}.initializationOptions`,
          ),
        }
      : {}),
  };
}

export function validateLspServersConfig(
  value: unknown,
  path = 'lspServers',
): LspServersConfig {
  if (!isPlainObject(value)) {
    throw new Error(`\`${path}\` must be an object.`);
  }
  const result: LspServersConfig = {};
  for (const [name, config] of Object.entries(value)) {
    if (!name.trim()) {
      throw new Error(`\`${path}\` contains an empty server name.`);
    }
    result[name] = validateServerConfig(config, `${path}.${name}`);
  }
  return result;
}

export function parseLspConfigDocument(
  value: unknown,
  path = 'lspConfig',
): LspServersConfig {
  if (!isPlainObject(value)) {
    throw new Error(`\`${path}\` must be an object.`);
  }
  if ('lspServers' in value) {
    return validateLspServersConfig(value.lspServers, `${path}.lspServers`);
  }
  return validateLspServersConfig(value, path);
}

export function loadLspConfigFile(filePath: string): LspServersConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read LSP config ${filePath}: ${message}`);
  }
  return parseLspConfigDocument(parsed, filePath);
}

export function loadLspServersFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): LspServersConfig {
  return mergeLspServers(
    env.LSP_CONFIG ? loadLspConfigFile(env.LSP_CONFIG) : undefined,
    env.LSP_SERVERS
      ? parseLspConfigDocument(JSON.parse(env.LSP_SERVERS), 'LSP_SERVERS')
      : undefined,
  );
}

export function loadProjectLspServers(
  cwd: string | undefined,
): LspServersConfig {
  if (!cwd) {
    return {};
  }
  const configs: LspServersConfig[] = [autoDetectLspServers(cwd)];
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    for (const relative of PROJECT_LSP_CONFIG_FILES) {
      const filePath = join(dir, relative);
      if (!existsSync(filePath)) {
        continue;
      }
      try {
        if (statSync(filePath).isFile()) {
          configs.push(loadLspConfigFile(filePath));
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
  return mergeLspServers(...configs);
}

export function autoDetectLspServers(
  cwd: string,
  options: AutoDetectOptions = {},
): LspServersConfig {
  const which = options.which ?? defaultWhich;
  const root = resolve(cwd);
  const detected: LspServersConfig = {};

  if (
    (existsSync(join(root, 'package.json')) ||
      existsSync(join(root, 'tsconfig.json'))) &&
    which('typescript-language-server')
  ) {
    detected.typescript = {
      command: 'typescript-language-server',
      args: ['--stdio'],
      language: 'typescript',
      fileExtensions: ['.ts', '.tsx', '.js', '.jsx'],
    };
  }

  if (existsSync(join(root, 'Cargo.toml')) && which('rust-analyzer')) {
    detected.rust = {
      command: 'rust-analyzer',
      language: 'rust',
      fileExtensions: ['.rs'],
    };
  }

  if (existsSync(join(root, 'go.mod')) && which('gopls')) {
    detected.go = {
      command: 'gopls',
      language: 'go',
      fileExtensions: ['.go'],
    };
  }

  if (
    (existsSync(join(root, 'pyproject.toml')) ||
      existsSync(join(root, 'requirements.txt'))) &&
    which('pyright-langserver')
  ) {
    detected.python = {
      command: 'pyright-langserver',
      args: ['--stdio'],
      language: 'python',
      fileExtensions: ['.py'],
    };
  }

  return detected;
}

export function mergeLspServers(
  ...configs: Array<LspServersConfig | undefined>
): LspServersConfig {
  return Object.assign({}, ...configs.filter(Boolean));
}
