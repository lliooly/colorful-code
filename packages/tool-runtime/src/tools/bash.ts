import { spawn } from 'node:child_process';
import {
  booleanField,
  objectSchema,
  optionalField,
  numberField,
  stringField,
} from '../core/schema.js';
import {
  buildTool,
  type RuntimeBackgroundProcess,
  type RuntimeContext,
  type Tool,
} from '../core/tool.js';

const bashInputSchema = objectSchema({
  command: stringField(),
  timeoutMs: optionalField(numberField()),
  run_in_background: optionalField(booleanField()),
});

type BashInput = ReturnType<typeof bashInputSchema.parse>;
type BashOutput = { stdout: string; stderr: string; code: number | null };
type BoundedOutput = {
  append(chunk: string): void;
  value(): string;
};

const MAX_BASH_STREAM_CHARS = 20_000;

const READ_ONLY_COMMANDS = new Set([
  'cat',
  'head',
  'tail',
  'ls',
  'find',
  'grep',
  'rg',
  'pwd',
  'wc',
  'stat',
  'git status',
  'git diff',
  'git log',
]);

function firstCommand(command: string): string {
  return command.trim().split(/\s+/).slice(0, 2).join(' ');
}

function hasLeadingEnvironmentAssignment(command: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(command.trimStart());
}

function hasComplexShellSyntax(command: string): boolean {
  let quote: "'" | '"' | undefined;
  let escaped = false;

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === '\\') {
      escaped = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = undefined;
        continue;
      }
      if (
        quote === '"' &&
        (char === '`' || (char === '$' && command[index + 1] === '('))
      ) {
        return true;
      }
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }

    if (
      char === ';' ||
      char === '&' ||
      char === '|' ||
      char === '<' ||
      char === '>' ||
      char === '\n' ||
      char === '`' ||
      (char === '$' && command[index + 1] === '(')
    ) {
      return true;
    }
  }

  return false;
}

function isReadOnlyCommand(command: string): boolean {
  const trimmed = command.trim();
  if (
    hasLeadingEnvironmentAssignment(trimmed) ||
    hasComplexShellSyntax(trimmed)
  ) {
    return false;
  }
  const first = trimmed.split(/\s+/)[0] ?? '';
  return (
    READ_ONLY_COMMANDS.has(first) ||
    READ_ONLY_COMMANDS.has(firstCommand(trimmed))
  );
}

function createBoundedOutput(maxChars = MAX_BASH_STREAM_CHARS): BoundedOutput {
  const headLimit = Math.ceil(maxChars / 2);
  const tailLimit = Math.floor(maxChars / 2);
  let full = '';
  let head = '';
  let tail = '';
  let seen = 0;
  let truncated = false;

  return {
    append(chunk) {
      seen += chunk.length;
      if (!truncated) {
        if (full.length + chunk.length <= maxChars) {
          full += chunk;
          return;
        }
        const combined = full + chunk;
        head = combined.slice(0, headLimit);
        tail = combined.slice(-tailLimit);
        full = '';
        truncated = true;
        return;
      }
      tail = (tail + chunk).slice(-tailLimit);
    },
    value() {
      if (!truncated) {
        return full;
      }
      const omitted = seen - head.length - tail.length;
      return (
        head +
        '\n\n[Bash output truncated: omitted ' +
        omitted +
        ' characters; showing first ' +
        head.length +
        ' and last ' +
        tail.length +
        ' characters]\n\n' +
        tail
      );
    },
  };
}

function ensureBackgroundProcesses(
  context: RuntimeContext,
): Map<string, RuntimeBackgroundProcess> {
  if (!context.backgroundProcesses) {
    context.backgroundProcesses = new Map();
  }
  return context.backgroundProcesses;
}

function nextBackgroundProcessId(context: RuntimeContext): string {
  const processes = ensureBackgroundProcesses(context);
  let index = processes.size + 1;
  let id = 'bash-' + String(index);
  while (processes.has(id)) {
    index += 1;
    id = 'bash-' + String(index);
  }
  return id;
}

function pushNotification(context: RuntimeContext, message: string): void {
  if (!context.notifications) {
    context.notifications = [];
  }
  context.notifications.push(message);
}

export const BashTool = buildTool<BashInput, BashOutput>({
  name: 'Bash',
  inputSchema: bashInputSchema,
  isReadOnly(input) {
    return isReadOnlyCommand(input.command);
  },
  isConcurrencySafe(input) {
    return isReadOnlyCommand(input.command);
  },
  isDestructive(input) {
    return !isReadOnlyCommand(input.command);
  },
  async call(input, context) {
    if (input.run_in_background === true) {
      const id = nextBackgroundProcessId(context);
      const stdout = createBoundedOutput();
      const stderr = createBoundedOutput();
      const child = spawn('sh', ['-lc', input.command], {
        cwd: context.cwd,
        signal: context.signal,
      });
      const now = Date.now();
      const process: RuntimeBackgroundProcess = {
        id,
        command: input.command,
        ...(context.cwd ? { cwd: context.cwd } : {}),
        ...(child.pid ? { pid: child.pid } : {}),
        status: 'running',
        stdout: '',
        stderr: '',
        code: null,
        signal: null,
        startedAt: now,
        updatedAt: now,
        kill(signal = 'SIGTERM') {
          return child.kill(signal);
        },
      };
      ensureBackgroundProcesses(context).set(id, process);

      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        stdout.append(chunk);
        process.stdout = stdout.value();
        process.updatedAt = Date.now();
      });
      child.stderr.on('data', (chunk: string) => {
        stderr.append(chunk);
        process.stderr = stderr.value();
        process.updatedAt = Date.now();
      });
      child.on('error', (error) => {
        process.status = 'error';
        process.error = error.message;
        process.updatedAt = Date.now();
        pushNotification(
          context,
          'Background command failed: ' + id + ' (' + error.message + ')',
        );
      });
      child.on('close', (code, signal) => {
        process.status = 'exited';
        process.code = code;
        process.signal = signal;
        process.stdout = stdout.value();
        process.stderr = stderr.value();
        process.updatedAt = Date.now();
        pushNotification(
          context,
          'Background command completed: ' +
            id +
            ' (exit ' +
            String(code) +
            (signal ? ', signal ' + signal : '') +
            ')',
        );
      });

      return {
        data: {
          stdout:
            'Background command started: ' +
            id +
            (child.pid ? ' (pid ' + child.pid + ')' : ''),
          stderr: '',
          code: null,
        },
      };
    }

    const timeoutMs = input.timeoutMs ?? 30_000;
    return await new Promise((resolve, reject) => {
      const child = spawn('sh', ['-lc', input.command], {
        cwd: context.cwd,
        signal: context.signal,
      });
      const stdout = createBoundedOutput();
      const stderr = createBoundedOutput();
      const timeout = setTimeout(() => {
        child.kill('SIGTERM');
        reject(new Error('Command timed out after ' + timeoutMs + 'ms'));
      }, timeoutMs);

      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        stdout.append(chunk);
      });
      child.stderr.on('data', (chunk: string) => {
        stderr.append(chunk);
      });
      child.on('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.on('close', (code) => {
        clearTimeout(timeout);
        resolve({ data: { stdout: stdout.value(), stderr: stderr.value(), code } });
      });
    });
  },
  mapResult(data, toolUseId) {
    const content = [
      data.stdout.trimEnd(),
      data.stderr.trimEnd(),
      data.code === 0 || data.code === null ? '' : 'Exit code ' + data.code,
    ]
      .filter(Boolean)
      .join('\n');
    return {
      toolUseId,
      content,
      isError: data.code === null ? undefined : data.code !== 0,
    };
  },
});

export function createBashTools(): Tool[] {
  return [BashTool];
}
