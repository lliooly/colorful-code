import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadEnvFile } from 'node:process';

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
}

export interface RedactedServerEnvironment {
  nodeEnv: NodeEnvironment;
  isProduction: boolean;
  host: string;
  port: number;
  corsOrigins: string[];
  providerKeys: Record<ProviderKeyName, '[set]' | '[unset]'>;
}

type EnvironmentSource = NodeJS.ProcessEnv;

const defaultCorsOrigins = ['http://localhost:3000'];

export function loadDevelopmentEnvFileIfPresent(
  cwd = process.cwd(),
  env = process.env
): void {
  if (env.NODE_ENV === 'production') {
    return;
  }

  const envPath = join(cwd, '.env');
  if (existsSync(envPath)) {
    loadEnvFile(envPath);
  }
}

export function loadServerEnvironment(
  env: EnvironmentSource = process.env
): ServerEnvironment {
  const nodeEnv = parseNodeEnv(env.NODE_ENV);
  const isProduction = nodeEnv === 'production';
  const host = readNonEmpty(env.HOST) ?? '127.0.0.1';
  const port = parsePort(env.PORT);
  const corsOrigins = parseCorsOrigins(env.CORS_ORIGIN, isProduction);

  return {
    nodeEnv,
    isProduction,
    host,
    port,
    corsOrigins,
    providerKeys: {
      anthropic: readNonEmpty(env.ANTHROPIC_API_KEY),
      openai: readNonEmpty(env.OPENAI_API_KEY),
      deepseek: readNonEmpty(env.DEEPSEEK_API_KEY)
    }
  };
}

export function toRedactedServerEnvironment(
  config: ServerEnvironment
): RedactedServerEnvironment {
  return {
    nodeEnv: config.nodeEnv,
    isProduction: config.isProduction,
    host: config.host,
    port: config.port,
    corsOrigins: config.corsOrigins,
    providerKeys: {
      anthropic: redact(config.providerKeys.anthropic),
      openai: redact(config.providerKeys.openai),
      deepseek: redact(config.providerKeys.deepseek)
    }
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
    return 3001;
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
  isProduction: boolean
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
    assertHttpOrigin(origin);
  }

  return origins;
}

function assertHttpOrigin(origin: string): void {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new Error('CORS_ORIGIN entries must be absolute http(s) origins');
  }

  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.origin !== origin ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new Error('CORS_ORIGIN entries must be absolute http(s) origins');
  }
}

function readNonEmpty(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

function redact(value: string | undefined): '[set]' | '[unset]' {
  return value ? '[set]' : '[unset]';
}
