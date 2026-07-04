export type ModelProtocol = 'anthropic' | 'openai';

export type CliOptions = {
  apiBaseUrl: string;
  cwd: string;
  prompt: string;
  apiKey?: string;
  preset?: string;
  protocol?: ModelProtocol;
  model?: string;
  baseURL?: string;
  mcpConfigPath?: string;
  mcpServers?: Record<string, unknown>;
};

export type CreateSessionBody = {
  cwd: string;
  workspaceRoots: string[];
  model?: {
    preset?: string;
    apiKey?: string;
    protocol?: ModelProtocol;
    model?: string;
    baseURL?: string;
  };
  mcpServers?: Record<string, unknown>;
};

export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliUsageError';
  }
}

const DEFAULT_API_BASE_URL = 'http://127.0.0.1:3367';
const DEFAULT_ANTHROPIC_MODEL = 'claude-fable-5';
const DEFAULT_OPENAI_MODEL = 'gpt-5.5';

export function parseCliArgs(
  argv: string[],
  env: Record<string, string | undefined> = process.env,
): CliOptions {
  const values: Partial<CliOptions> = {};
  const positional: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg) {
      continue;
    }
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }

    const [flag, inlineValue] = arg.split('=', 2) as [string, string?];
    const value = inlineValue ?? argv[index + 1];
    if (inlineValue === undefined) {
      index += 1;
    }
    if (value === undefined || value.startsWith('--')) {
      throw new CliUsageError(`${flag} requires a value.`);
    }

    switch (flag) {
      case '--api-base':
        values.apiBaseUrl = stripTrailingSlash(value);
        break;
      case '--api-key':
        values.apiKey = value;
        break;
      case '--cwd':
        values.cwd = value;
        break;
      case '--prompt':
        values.prompt = value;
        break;
      case '--preset':
        values.preset = value;
        break;
      case '--protocol':
        values.protocol = parseProtocol(value);
        break;
      case '--model':
        values.model = value;
        break;
      case '--base-url':
        values.baseURL = value;
        break;
      case '--mcp-config':
        values.mcpConfigPath = value;
        break;
      default:
        throw new CliUsageError(`Unknown option: ${flag}`);
    }
  }

  const prompt = values.prompt ?? positional.join(' ').trim();
  if (!prompt) {
    throw new CliUsageError(
      'A prompt is required. Use --prompt "..." or pass it as positional text.',
    );
  }

  const cwd = values.cwd ?? env.PWD ?? process.cwd();
  return {
    apiBaseUrl: stripTrailingSlash(
      values.apiBaseUrl ??
        env.COLORFUL_CODE_API_BASE_URL ??
        DEFAULT_API_BASE_URL,
    ),
    ...((values.apiKey ?? env.COLORFUL_CODE_API_KEY)
      ? { apiKey: values.apiKey ?? env.COLORFUL_CODE_API_KEY }
      : {}),
    cwd,
    prompt,
    ...(values.preset ? { preset: values.preset } : {}),
    ...(values.protocol ? { protocol: values.protocol } : {}),
    ...(values.model ? { model: values.model } : {}),
    ...(values.baseURL ? { baseURL: values.baseURL } : {}),
    ...(values.mcpConfigPath ? { mcpConfigPath: values.mcpConfigPath } : {}),
  };
}

export function buildCreateSessionBody(options: CliOptions): CreateSessionBody {
  const body: CreateSessionBody = {
    cwd: options.cwd,
    workspaceRoots: [options.cwd],
  };

  if (options.mcpServers) {
    body.mcpServers = options.mcpServers;
  }

  if (options.apiKey) {
    const protocol = options.protocol ?? 'anthropic';
    body.model = {
      preset: 'custom',
      apiKey: options.apiKey,
      protocol,
      model:
        options.model ??
        (protocol === 'anthropic'
          ? DEFAULT_ANTHROPIC_MODEL
          : DEFAULT_OPENAI_MODEL),
      ...(options.baseURL ? { baseURL: options.baseURL } : {}),
    };
    return body;
  }

  if (options.preset || options.protocol || options.model || options.baseURL) {
    body.model = {
      ...(options.preset ? { preset: options.preset } : {}),
      ...(options.protocol ? { protocol: options.protocol } : {}),
      ...(options.model ? { model: options.model } : {}),
      ...(options.baseURL ? { baseURL: options.baseURL } : {}),
    };
  }

  return body;
}

function parseProtocol(value: string): ModelProtocol {
  if (value === 'anthropic' || value === 'openai') {
    return value;
  }
  throw new CliUsageError("--protocol must be 'anthropic' or 'openai'.");
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}
