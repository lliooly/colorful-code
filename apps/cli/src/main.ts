#!/usr/bin/env bun
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { buildCreateSessionBody, CliUsageError, parseCliArgs } from './args';
import {
  createSession,
  sendControl,
  sendMessage,
  streamSessionEvents,
  type SessionEvent,
} from './api';

async function main(): Promise<void> {
  const options = parseCliArgs(process.argv.slice(2));
  const sessionOptions = options.mcpConfigPath
    ? {
        ...options,
        mcpServers: loadMcpServersConfig(options.mcpConfigPath),
      }
    : options;
  const sessionId = await createSession(
    options.apiBaseUrl,
    buildCreateSessionBody(sessionOptions),
  );
  console.error(`session ${sessionId}`);

  const abort = new AbortController();
  const rl = createInterface({ input, output });
  try {
    const stream = consumeEvents({
      apiBaseUrl: options.apiBaseUrl,
      sessionId,
      signal: abort.signal,
      rl,
      onTerminal: () => abort.abort(),
    });
    await sendMessage(options.apiBaseUrl, sessionId, options.prompt);
    await stream;
  } finally {
    rl.close();
  }
}

async function consumeEvents(args: {
  apiBaseUrl: string;
  sessionId: string;
  signal: AbortSignal;
  rl: ReturnType<typeof createInterface>;
  onTerminal: () => void;
}): Promise<void> {
  try {
    for await (const event of streamSessionEvents(
      args.apiBaseUrl,
      args.sessionId,
      args.signal,
    )) {
      await handleEvent(event, args);
      if (isTerminalRunStatus(event)) {
        args.onTerminal();
        return;
      }
    }
  } catch (error) {
    if (args.signal.aborted) {
      return;
    }
    throw error;
  }
}

async function handleEvent(
  event: SessionEvent,
  args: {
    apiBaseUrl: string;
    sessionId: string;
    rl: ReturnType<typeof createInterface>;
  },
): Promise<void> {
  switch (event.type) {
    case 'lsp_status':
      process.stderr.write(formatLspStatus(event) + '\n');
      return;
    case 'message_delta':
      process.stdout.write(String(event.text ?? ''));
      return;
    case 'tool_call':
      process.stderr.write(
        `\n> ${formatToolLabel(event)} ${JSON.stringify(event.input ?? {})}\n`,
      );
      return;
    case 'tool_result':
      process.stderr.write(
        `< ${formatToolResultLabel(event)} ${String(event.content ?? '')}\n`,
      );
      return;
    case 'approval_required':
      await answerApproval(event, args);
      return;
    case 'error':
      process.stderr.write(
        `\nerror: ${String(event.message ?? 'unknown error')}\n`,
      );
      return;
    case 'run_status':
      if (event.status === 'completed') {
        process.stdout.write('\n');
      } else if (event.status === 'cancelled' || event.status === 'error') {
        process.stderr.write(`\nrun ${String(event.status)}\n`);
      }
      return;
    default:
      return;
  }
}

async function answerApproval(
  event: SessionEvent,
  args: {
    apiBaseUrl: string;
    sessionId: string;
    rl: ReturnType<typeof createInterface>;
  },
): Promise<void> {
  const requestId = event.requestId;
  if (typeof requestId !== 'string') {
    process.stderr.write('\napproval event missing requestId; denying.\n');
    return;
  }

  process.stderr.write(
    `\napproval required for ${formatToolLabel(event)}\n${JSON.stringify(
      event.input ?? {},
      null,
      2,
    )}\n`,
  );
  const answer = (await args.rl.question('allow? [y/N] ')).trim().toLowerCase();
  const allowed = answer === 'y' || answer === 'yes' || answer === 'a';
  await sendControl(args.apiBaseUrl, args.sessionId, {
    type: 'approval_response',
    requestId,
    decision: allowed
      ? { behavior: 'allow' }
      : { behavior: 'deny', message: 'Denied by CLI user.' },
  });
}

function isTerminalRunStatus(event: SessionEvent): boolean {
  return (
    event.type === 'run_status' &&
    (event.status === 'completed' ||
      event.status === 'cancelled' ||
      event.status === 'error')
  );
}

main().catch((error) => {
  if (error instanceof CliUsageError) {
    process.stderr.write(`${error.message}\n\n${usage()}\n`);
    process.exitCode = 2;
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});

function usage(): string {
  return [
    'Usage:',
    '  colorful-code --api-key <key> --cwd <path> --prompt "fix the test"',
    '',
    'Options:',
    '  --api-base <url>     Server URL (default http://127.0.0.1:3001)',
    '  --api-key <key>      BYO provider key; sent via the custom model preset',
    '  --cwd <path>         Session working directory',
    '  --prompt <text>      First user prompt',
    '  --protocol <name>    anthropic | openai (default anthropic with --api-key)',
    '  --model <id>         Provider model id',
    '  --base-url <url>     Provider base URL for custom/OpenAI-compatible hosts',
    '  --preset <id>        Server-side preset when no --api-key is supplied',
    '  --mcp-config <path>  JSON config containing an mcpServers object',
  ].join('\n');
}

function loadMcpServersConfig(path: string): Record<string, unknown> {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new CliUsageError('--mcp-config must point to a JSON object.');
  }
  if ('mcpServers' in parsed) {
    const mcpServers = (parsed as { mcpServers?: unknown }).mcpServers;
    if (
      typeof mcpServers !== 'object' ||
      mcpServers === null ||
      Array.isArray(mcpServers)
    ) {
      throw new CliUsageError('mcpServers must be an object.');
    }
    return mcpServers as Record<string, unknown>;
  }
  return parsed as Record<string, unknown>;
}

function formatToolLabel(event: SessionEvent): string {
  const name = String(event.name ?? 'tool');
  const source = event.source;
  if (
    source &&
    typeof source === 'object' &&
    (source as { type?: unknown }).type === 'mcp' &&
    typeof (source as { server?: unknown }).server === 'string'
  ) {
    return `mcp:${(source as { server: string }).server} ${name}`;
  }
  if (
    source &&
    typeof source === 'object' &&
    (source as { type?: unknown }).type === 'lsp'
  ) {
    return `lsp ${name}`;
  }
  return name;
}

function formatToolResultLabel(event: SessionEvent): string {
  const source = event.source;
  if (
    source &&
    typeof source === 'object' &&
    (source as { type?: unknown }).type === 'mcp' &&
    typeof (source as { server?: unknown }).server === 'string'
  ) {
    return `mcp:${(source as { server: string }).server} ${String(
      event.toolUseId ?? 'tool',
    )}`;
  }
  if (
    source &&
    typeof source === 'object' &&
    (source as { type?: unknown }).type === 'lsp'
  ) {
    return `lsp ${String(event.toolUseId ?? 'tool')}`;
  }
  return String(event.toolUseId ?? 'tool');
}

function formatLspStatus(event: SessionEvent): string {
  const servers = Array.isArray(event.servers) ? event.servers : [];
  if (servers.length === 0) {
    return 'lsp: no servers configured';
  }
  const summary = servers
    .map((server) => {
      if (!server || typeof server !== 'object') {
        return 'unknown';
      }
      const value = server as {
        name?: unknown;
        language?: unknown;
        status?: unknown;
        error?: unknown;
      };
      return [
        String(value.name ?? 'unknown'),
        String(value.language ?? 'unknown'),
        String(value.status ?? 'unknown'),
        typeof value.error === 'string' ? value.error : undefined,
      ]
        .filter(Boolean)
        .join(':');
    })
    .join(', ');
  return `lsp: ${summary}`;
}
