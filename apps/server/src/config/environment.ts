import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

type NodeEnvironment = 'development' | 'production' | 'test';

type ProviderKeyName = 'anthropic' | 'openai' | 'deepseek';

type ProviderKeys = Record<ProviderKeyName, string | undefined>;

export interface ServerEnvironment {
  nodeEnv: NodeEnvironment;
  isProduction: boolean;
  host: string;
  port: number;
  corsOrigins: string[];
  providerKeys: ProviderKeys;
  // Filesystem path to the SQLite persistence file. Defaults to
  // `./data/colorful-code.db` (gitignored); override with `DATABASE_PATH`. The
  // special value `:memory:` opens an ephemeral in-process DB (used by tests).
  databasePath: string;
}

export interface RedactedServerEnvironment {
  nodeEnv: NodeEnvironment;
  isProduction: boolean;
  host: string;
  port: number;
  corsOrigins: string[];
  providerKeys: Record<ProviderKeyName, '[set]' | '[unset]'>;
  databasePath: string;
}

type EnvironmentSource = NodeJS.ProcessEnv;

const defaultCorsOrigins = [
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://tauri.localhost',
  'https://tauri.localhost',
  'tauri://localhost',
  'null',
];

const defaultDatabasePath = './data/colorful-code.db';

export function loadDevelopmentEnvFileIfPresent(
  cwd = process.cwd(),
  env = process.env,
): void {
  if (env.NODE_ENV === 'production') {
    return;
  }

  const envPath = join(cwd, '.env');
  if (!existsSync(envPath)) {
    return;
  }

  // Load the dev `.env` into `process.env`. We parse it ourselves rather than use
  // Node's `process.loadEnvFile` (Node-only; Bun, the runtime target, lacks it —
  // Bun only auto-loads the startup-cwd `.env`, not an arbitrary path). Minimal
  // `KEY=VALUE` parsing is enough for a dev convenience file; already-set vars are
  // left untouched so the shell environment always wins.
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) {
      continue;
    }
    const separator = trimmed.indexOf('=');
    if (separator <= 0) {
      continue;
    }
    const key = trimmed.slice(0, separator).trim();
    if (key in process.env) {
      continue;
    }
    let value = trimmed.slice(separator + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

export function loadServerDevelopmentEnvFiles(
  cwd = process.cwd(),
  env = process.env,
): void {
  if (env.NODE_ENV === 'production') {
    return;
  }

  loadDevelopmentEnvFileIfPresent(join(cwd, 'apps/server'), env);
  loadDevelopmentEnvFileIfPresent(cwd, env);
}

export function loadServerEnvironment(
  env: EnvironmentSource = process.env,
): ServerEnvironment {
  const nodeEnv = parseNodeEnv(env.NODE_ENV);
  const isProduction = nodeEnv === 'production';
  const host = readNonEmpty(env.HOST) ?? '127.0.0.1';
  const port = parsePort(env.PORT);
  const corsOrigins = parseCorsOrigins(env.CORS_ORIGIN, isProduction);
  const databasePath = readNonEmpty(env.DATABASE_PATH) ?? defaultDatabasePath;

  return {
    nodeEnv,
    isProduction,
    host,
    port,
    corsOrigins,
    databasePath,
    providerKeys: {
      anthropic: readNonEmpty(env.ANTHROPIC_API_KEY),
      openai: readNonEmpty(env.OPENAI_API_KEY),
      deepseek: readNonEmpty(env.DEEPSEEK_API_KEY),
    },
  };
}

export function toRedactedServerEnvironment(
  config: ServerEnvironment,
): RedactedServerEnvironment {
  return {
    nodeEnv: config.nodeEnv,
    isProduction: config.isProduction,
    host: config.host,
    port: config.port,
    corsOrigins: config.corsOrigins,
    databasePath: config.databasePath,
    providerKeys: {
      anthropic: redact(config.providerKeys.anthropic),
      openai: redact(config.providerKeys.openai),
      deepseek: redact(config.providerKeys.deepseek),
    },
  };
}

function parseNodeEnv(value: string | undefined): NodeEnvironment {
  const normalized = readNonEmpty(value) ?? 'development';
  if (
    normalized === 'development' ||
    normalized === 'production' ||
    normalized === 'test'
  ) {
    return normalized;
  }
  throw new Error('NODE_ENV must be development, production, or test');
}

function parsePort(value: string | undefined): number {
  const normalized = readNonEmpty(value);
  if (!normalized) {
    return 3367;
  }
  if (!/^\d+$/.test(normalized)) {
    throw new Error('PORT must be an integer between 1 and 65535');
  }
  const port = Number(normalized);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535');
  }
  return port;
}

function parseCorsOrigins(
  value: string | undefined,
  isProduction: boolean,
): string[] {
  const normalized = readNonEmpty(value);
  if (!normalized) {
    if (isProduction) {
      throw new Error('CORS_ORIGIN is required when NODE_ENV=production');
    }
    return defaultCorsOrigins;
  }

  const origins = normalized
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);

  if (origins.length === 0) {
    throw new Error('CORS_ORIGIN must include at least one origin');
  }

  for (const origin of origins) {
    assertCorsOrigin(origin);
  }

  return expandDevelopmentCorsOrigins(origins, isProduction);
}

function expandDevelopmentCorsOrigins(
  origins: string[],
  isProduction: boolean,
): string[] {
  if (isProduction || !origins.some((origin) => defaultCorsOrigins.includes(origin))) {
    return origins;
  }

  return [...new Set([...origins, ...defaultCorsOrigins])];
}

function assertCorsOrigin(origin: string): void {
  if (origin === 'null') {
    return;
  }

  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new Error(
      'CORS_ORIGIN entries must be absolute http(s), Tauri, or null origins',
    );
  }

  const validHttpOrigin =
    (url.protocol === 'http:' || url.protocol === 'https:') &&
    url.origin === origin &&
    url.pathname === '/' &&
    url.search === '' &&
    url.hash === '';
  const validTauriOrigin = origin === 'tauri://localhost';

  if (!validHttpOrigin && !validTauriOrigin) {
    throw new Error(
      'CORS_ORIGIN entries must be absolute http(s), Tauri, or null origins',
    );
  }
}

function readNonEmpty(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

function redact(value: string | undefined): '[set]' | '[unset]' {
  return value ? '[set]' : '[unset]';
}
