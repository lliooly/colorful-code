import { createInterface } from 'node:readline';

const reader = createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

let nextContentLength = undefined;
let buffer = Buffer.alloc(0);
const openDocuments = new Map();
const messages = [];

function send(message) {
  const body = JSON.stringify(message);
  process.stdout.write(
    'Content-Length: ' + Buffer.byteLength(body, 'utf8') + '\r\n\r\n' + body,
  );
}

function position(line, character) {
  return { line, character };
}

function range(startLine, startCharacter, endLine, endCharacter) {
  return {
    start: position(startLine, startCharacter),
    end: position(endLine, endCharacter),
  };
}

function location(uri, line, character) {
  return { uri, range: range(line, character, line, character + 6) };
}

function handle(message) {
  messages.push(message.method ?? 'response');
  if (message.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        capabilities: {
          definitionProvider: true,
          referencesProvider: true,
          hoverProvider: true,
          documentSymbolProvider: true,
          workspaceSymbolProvider: true,
          textDocumentSync: 1,
        },
      },
    });
    return;
  }

  if (message.method === 'shutdown') {
    send({ jsonrpc: '2.0', id: message.id, result: null });
    return;
  }

  if (message.method === 'exit') {
    process.exit(0);
  }

  if (message.method === 'textDocument/didOpen') {
    const doc = message.params.textDocument;
    openDocuments.set(doc.uri, doc.text);
    return;
  }

  if (message.method === 'textDocument/didChange') {
    const uri = message.params.textDocument.uri;
    const change = message.params.contentChanges.at(-1);
    openDocuments.set(uri, change?.text ?? '');
    return;
  }

  if (message.method === 'textDocument/definition') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: [location(message.params.textDocument.uri, 2, 7)],
    });
    return;
  }

  if (message.method === 'textDocument/references') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: [
        location(message.params.textDocument.uri, 1, 3),
        location(message.params.textDocument.uri, 4, 8),
      ],
    });
    return;
  }

  if (message.method === 'textDocument/diagnostic') {
    const uri = message.params.textDocument.uri;
    const text = openDocuments.get(uri) ?? '';
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        kind: 'full',
        items: text.includes('broken')
          ? [
              {
                range: range(0, 0, 0, 6),
                severity: 1,
                message: 'Found broken text',
                source: 'fixture-lsp',
              },
            ]
          : [],
      },
    });
    return;
  }

  if (message.method === 'textDocument/publishDiagnostics') {
    return;
  }

  if (message.method === 'textDocument/hover') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        contents: { kind: 'markdown', value: '`fixtureHover(): string`' },
        range: range(0, 0, 0, 12),
      },
    });
    return;
  }

  if (message.method === 'textDocument/documentSymbol') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: [
        {
          name: 'fixtureSymbol',
          kind: 12,
          range: range(0, 0, 3, 1),
          selectionRange: range(0, 9, 0, 22),
          children: [],
        },
      ],
    });
    return;
  }

  if (message.method === 'workspace/symbol') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: [
        {
          name: 'fixtureWorkspaceSymbol',
          kind: 12,
          location: location(message.params.query, 0, 0),
        },
      ],
    });
  }
}

function consume() {
  while (true) {
    if (nextContentLength === undefined) {
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) {
        return;
      }
      const header = buffer.subarray(0, headerEnd).toString('utf8');
      const match = /Content-Length:\s*(\d+)/i.exec(header);
      if (!match) {
        throw new Error('Missing Content-Length');
      }
      nextContentLength = Number(match[1]);
      buffer = buffer.subarray(headerEnd + 4);
    }

    if (buffer.length < nextContentLength) {
      return;
    }

    const body = buffer.subarray(0, nextContentLength).toString('utf8');
    buffer = buffer.subarray(nextContentLength);
    nextContentLength = undefined;
    handle(JSON.parse(body));
  }
}

process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  consume();
});

reader.on('close', () => process.exit(0));
