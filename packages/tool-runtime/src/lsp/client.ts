import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { extname, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import type {
  Diagnostic,
  DocumentSymbol,
  Hover,
  Location,
  LspManager,
  LspServerConfig,
  LspServerConnection,
  SymbolInformation,
} from './types.js';

type JsonRpcMessage = {
  jsonrpc?: '2.0';
  id?: number | string | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { message?: string };
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

type OpenDocument = {
  uri: string;
  content: string;
  version: number;
};

type LspClientConnection = {
  name: string;
  config: LspServerConfig;
  process: ChildProcessWithoutNullStreams;
  capabilities: Record<string, unknown>;
  pending: Map<number, PendingRequest>;
  openDocuments: Map<string, OpenDocument>;
  nextId: number;
  buffer: Buffer;
  contentLength?: number;
  closed: boolean;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asArray<T>(value: T | T[] | null | undefined): T[] {
  if (value === null || value === undefined) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function uriForFile(file: string): string {
  return pathToFileURL(resolve(file)).href;
}

function languageId(config: LspServerConfig): string {
  return config.language === 'typescript' ? 'typescript' : config.language;
}

function readHeaderLength(header: string): number {
  const match = /Content-Length:\s*(\d+)/i.exec(header);
  if (!match) {
    throw new Error('LSP response is missing Content-Length.');
  }
  return Number(match[1]);
}

function writeMessage(
  connection: LspClientConnection,
  message: JsonRpcMessage,
): void {
  const body = JSON.stringify({ jsonrpc: '2.0', ...message });
  connection.process.stdin.write(
    'Content-Length: ' + Buffer.byteLength(body, 'utf8') + '\r\n\r\n' + body,
  );
}

function readMessages(
  connection: LspClientConnection,
  chunk: Buffer,
): JsonRpcMessage[] {
  connection.buffer = Buffer.concat([connection.buffer, chunk]);
  const messages: JsonRpcMessage[] = [];

  while (true) {
    if (connection.contentLength === undefined) {
      const headerEnd = connection.buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) {
        break;
      }
      connection.contentLength = readHeaderLength(
        connection.buffer.subarray(0, headerEnd).toString('utf8'),
      );
      connection.buffer = connection.buffer.subarray(headerEnd + 4);
    }

    if (connection.buffer.length < connection.contentLength) {
      break;
    }

    const body = connection.buffer
      .subarray(0, connection.contentLength)
      .toString('utf8');
    connection.buffer = connection.buffer.subarray(connection.contentLength);
    connection.contentLength = undefined;
    messages.push(JSON.parse(body) as JsonRpcMessage);
  }

  return messages;
}

function attachReaders(connection: LspClientConnection): void {
  connection.process.stdout.on('data', (chunk: Buffer) => {
    try {
      for (const message of readMessages(connection, chunk)) {
        if (typeof message.id !== 'number') {
          continue;
        }
        const pending = connection.pending.get(message.id);
        if (!pending) {
          continue;
        }
        connection.pending.delete(message.id);
        if (message.error) {
          pending.reject(new Error(message.error.message ?? 'LSP request failed'));
        } else {
          pending.resolve(message.result);
        }
      }
    } catch (error) {
      for (const pending of connection.pending.values()) {
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      }
      connection.pending.clear();
    }
  });

  connection.process.on('error', (error) => {
    for (const pending of connection.pending.values()) {
      pending.reject(error);
    }
    connection.pending.clear();
  });

  connection.process.on('close', () => {
    connection.closed = true;
    for (const pending of connection.pending.values()) {
      pending.reject(new Error('LSP server exited.'));
    }
    connection.pending.clear();
  });
}

function request(
  connection: LspClientConnection,
  method: string,
  params?: unknown,
): Promise<unknown> {
  const id = connection.nextId++;
  writeMessage(connection, { id, method, params });
  return new Promise((resolve, reject) => {
    connection.pending.set(id, { resolve, reject });
  });
}

function notify(
  connection: LspClientConnection,
  method: string,
  params?: unknown,
): void {
  writeMessage(connection, { method, params });
}

async function closeConnection(
  connection: LspClientConnection,
): Promise<void> {
  if (connection.closed) {
    return;
  }
  try {
    await request(connection, 'shutdown');
  } catch {
    // Shutdown is best-effort. The child may already be gone.
  }
  try {
    notify(connection, 'exit');
  } catch {
    // Ignore close races.
  }
  connection.process.kill();
  connection.closed = true;
}

function spawnConnection(
  name: string,
  config: LspServerConfig,
): LspClientConnection {
  const child = spawn(config.command, config.args ?? [], {
    env: { ...process.env, ...(config.env ?? {}) },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stderr.resume();
  const connection: LspClientConnection = {
    name,
    config,
    process: child,
    capabilities: {},
    pending: new Map(),
    openDocuments: new Map(),
    nextId: 1,
    buffer: Buffer.alloc(0),
    closed: false,
  };
  attachReaders(connection);
  return connection;
}

function isLocation(value: unknown): value is Location {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Location).uri === 'string' &&
    typeof (value as Location).range === 'object'
  );
}

function isDocumentSymbol(value: unknown): value is DocumentSymbol {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as DocumentSymbol).name === 'string' &&
    typeof (value as DocumentSymbol).kind === 'number' &&
    typeof (value as DocumentSymbol).range === 'object'
  );
}

function isSymbolInformation(value: unknown): value is SymbolInformation {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as SymbolInformation).name === 'string' &&
    typeof (value as SymbolInformation).kind === 'number' &&
    typeof (value as SymbolInformation).location === 'object'
  );
}

function diagnosticsFromResult(result: unknown): Diagnostic[] {
  const items =
    result && typeof result === 'object' && 'items' in result
      ? (result as { items?: unknown }).items
      : result;
  return asArray(items).filter(
    (item): item is Diagnostic =>
      typeof item === 'object' &&
      item !== null &&
      typeof (item as Diagnostic).message === 'string' &&
      typeof (item as Diagnostic).range === 'object',
  );
}

export class SdkLspManager implements LspManager {
  private workspaceRoot = process.cwd();
  private readonly connections = new Map<string, LspClientConnection>();
  private readonly cachedConnections = new Map<string, LspServerConnection>();

  constructor(private readonly configs: Record<string, LspServerConfig>) {}

  async initialize(workspaceRoot: string): Promise<LspServerConnection[]> {
    this.workspaceRoot = workspaceRoot;
    return await Promise.all(
      Object.entries(this.configs).map(async ([name, config]) =>
        this.connectOne(name, config),
      ),
    );
  }

  async goToDefinition(
    file: string,
    line: number,
    character: number,
  ): Promise<Location[]> {
    const connection = await this.ensureDocumentOpen(file);
    const result = await request(connection, 'textDocument/definition', {
      textDocument: { uri: uriForFile(file) },
      position: { line, character },
    });
    return asArray(result).filter(isLocation);
  }

  async findReferences(
    file: string,
    line: number,
    character: number,
  ): Promise<Location[]> {
    const connection = await this.ensureDocumentOpen(file);
    const result = await request(connection, 'textDocument/references', {
      textDocument: { uri: uriForFile(file) },
      position: { line, character },
      context: { includeDeclaration: true },
    });
    return asArray(result).filter(isLocation);
  }

  async getDiagnostics(file: string): Promise<Diagnostic[]> {
    const connection = await this.ensureDocumentOpen(file);
    const result = await request(connection, 'textDocument/diagnostic', {
      textDocument: { uri: uriForFile(file) },
    });
    return diagnosticsFromResult(result);
  }

  async hover(
    file: string,
    line: number,
    character: number,
  ): Promise<Hover | null> {
    const connection = await this.ensureDocumentOpen(file);
    const result = await request(connection, 'textDocument/hover', {
      textDocument: { uri: uriForFile(file) },
      position: { line, character },
    });
    return result && typeof result === 'object' ? (result as Hover) : null;
  }

  async documentSymbols(file: string): Promise<DocumentSymbol[]> {
    const connection = await this.ensureDocumentOpen(file);
    const result = await request(connection, 'textDocument/documentSymbol', {
      textDocument: { uri: uriForFile(file) },
    });
    return asArray(result).filter(isDocumentSymbol);
  }

  async workspaceSymbol(query: string): Promise<SymbolInformation[]> {
    await this.initialize(this.workspaceRoot);
    const symbols: SymbolInformation[] = [];
    for (const connection of this.connections.values()) {
      const result = await request(connection, 'workspace/symbol', { query });
      symbols.push(...asArray(result).filter(isSymbolInformation));
    }
    return symbols;
  }

  async didChange(file: string, content: string): Promise<void> {
    const connection = await this.ensureConnectedForFile(file);
    const uri = uriForFile(file);
    const existing = connection.openDocuments.get(uri);
    if (!existing) {
      notify(connection, 'textDocument/didOpen', {
        textDocument: {
          uri,
          languageId: languageId(connection.config),
          version: 1,
          text: content,
        },
      });
      connection.openDocuments.set(uri, { uri, content, version: 1 });
      return;
    }
    if (existing.content === content) {
      return;
    }
    const version = (existing?.version ?? 0) + 1;
    notify(connection, 'textDocument/didChange', {
      textDocument: { uri, version },
      contentChanges: [{ text: content }],
    });
    connection.openDocuments.set(uri, { uri, content, version });
  }

  async close(): Promise<void> {
    await Promise.all(
      [...this.connections.values()].map((connection) =>
        closeConnection(connection),
      ),
    );
    this.connections.clear();
    this.cachedConnections.clear();
  }

  private async connectOne(
    name: string,
    config: LspServerConfig,
  ): Promise<LspServerConnection> {
    const cached = this.cachedConnections.get(name);
    if (cached) {
      return cached;
    }

    try {
      const connection = spawnConnection(name, config);
      this.connections.set(name, connection);
      const result = await request(connection, 'initialize', {
        processId: process.pid,
        rootUri: uriForFile(this.workspaceRoot),
        workspaceFolders: [
          { uri: uriForFile(this.workspaceRoot), name: 'workspace' },
        ],
        capabilities: {},
        initializationOptions: config.initializationOptions,
      });
      const capabilities =
        result && typeof result === 'object' && 'capabilities' in result
          ? ((result as { capabilities?: Record<string, unknown> })
              .capabilities ?? {})
          : {};
      connection.capabilities = capabilities;
      notify(connection, 'initialized', {});

      const connected: LspServerConnection = {
        name,
        type: 'connected',
        language: config.language,
        config,
        capabilities,
        metadata: {
          name,
          language: config.language,
          fileExtensions: [...config.fileExtensions],
          capabilities,
        },
        close: async () => {
          await closeConnection(connection);
        },
      };
      this.cachedConnections.set(name, connected);
      return connected;
    } catch (error) {
      const failed: LspServerConnection = {
        name,
        type: 'failed',
        language: config.language,
        config,
        error: errorMessage(error),
      };
      this.cachedConnections.set(name, failed);
      return failed;
    }
  }

  private serverForFile(file: string): [string, LspServerConfig] | undefined {
    const extension = extname(file);
    return Object.entries(this.configs).find(([, config]) =>
      config.fileExtensions.includes(extension),
    );
  }

  private async ensureConnectedForFile(
    file: string,
  ): Promise<LspClientConnection> {
    const match = this.serverForFile(file);
    if (!match) {
      throw new Error('No LSP server configured for ' + extname(file));
    }
    const [name, config] = match;
    const existing = this.connections.get(name);
    if (existing) {
      return existing;
    }
    const status = await this.connectOne(name, config);
    if (status.type !== 'connected') {
      throw new Error('LSP server failed to connect: ' + status.error);
    }
    const connected = this.connections.get(name);
    if (!connected) {
      throw new Error('LSP server is not connected: ' + name);
    }
    return connected;
  }

  private async ensureDocumentOpen(
    file: string,
    content?: string,
  ): Promise<LspClientConnection> {
    const connection = await this.ensureConnectedForFile(file);
    const uri = uriForFile(file);
    const existing = connection.openDocuments.get(uri);
    const text = content ?? existing?.content ?? (await readFile(file, 'utf8').catch(() => ''));

    if (!existing) {
      notify(connection, 'textDocument/didOpen', {
        textDocument: {
          uri,
          languageId: languageId(connection.config),
          version: 1,
          text,
        },
      });
      connection.openDocuments.set(uri, { uri, content: text, version: 1 });
    } else if (content !== undefined && content !== existing.content) {
      const version = existing.version + 1;
      notify(connection, 'textDocument/didChange', {
        textDocument: { uri, version },
        contentChanges: [{ text: content }],
      });
      connection.openDocuments.set(uri, { uri, content, version });
    }

    return connection;
  }
}
