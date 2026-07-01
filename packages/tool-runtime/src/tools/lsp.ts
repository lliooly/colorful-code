import { extname } from 'node:path';
import {
  objectSchema,
  numberField,
  stringField,
} from '../core/schema.js';
import { buildTool, type RuntimeContext, type Tool } from '../core/tool.js';
import type {
  Diagnostic,
  DocumentSymbol,
  Hover,
  Location,
} from '../lsp/types.js';

const positionSchema = objectSchema({
  file: stringField(),
  line: numberField(),
  character: numberField(),
});

const fileSchema = objectSchema({
  file: stringField(),
});

type PositionInput = ReturnType<typeof positionSchema.parse>;
type FileInput = ReturnType<typeof fileSchema.parse>;

function noServerMessage(file: string): string {
  return 'No LSP server configured for ' + (extname(file) || file);
}

async function withLsp<T>(
  context: RuntimeContext,
  file: string,
  callback: () => Promise<T>,
): Promise<T | string> {
  if (!context.lspManager) {
    return noServerMessage(file);
  }
  try {
    return await callback();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith('No LSP server configured for ')) {
      return message;
    }
    throw error;
  }
}

function fileFromUri(uri: string): string {
  if (uri.startsWith('file://')) {
    try {
      return decodeURIComponent(new URL(uri).pathname);
    } catch {
      return uri;
    }
  }
  return uri;
}

function formatLocation(location: Location): string {
  return (
    fileFromUri(location.uri) +
    ':' +
    String(location.range.start.line + 1) +
    ':' +
    String(location.range.start.character + 1)
  );
}

function formatLocations(locations: Location[]): string {
  return locations.length > 0
    ? locations.map(formatLocation).join('\n')
    : 'No locations found.';
}

function formatDiagnostics(diagnostics: Diagnostic[]): string {
  return diagnostics.length > 0
    ? diagnostics
        .map(
          (diagnostic) =>
            String(diagnostic.range.start.line + 1) +
            ':' +
            String(diagnostic.range.start.character + 1) +
            ' ' +
            (diagnostic.source ? '[' + diagnostic.source + '] ' : '') +
            diagnostic.message,
        )
        .join('\n')
    : 'No diagnostics.';
}

function stringifyHoverContents(contents: unknown): string {
  if (typeof contents === 'string') {
    return contents;
  }
  if (
    contents &&
    typeof contents === 'object' &&
    'value' in contents &&
    typeof (contents as { value?: unknown }).value === 'string'
  ) {
    return (contents as { value: string }).value;
  }
  if (Array.isArray(contents)) {
    return contents.map(stringifyHoverContents).join('\n');
  }
  return JSON.stringify(contents);
}

function formatHover(hover: Hover | null): string {
  return hover ? stringifyHoverContents(hover.contents) : 'No hover result.';
}

function formatDocumentSymbol(symbol: DocumentSymbol, depth = 0): string {
  const prefix = '  '.repeat(depth);
  const line =
    prefix +
    symbol.name +
    ' kind=' +
    String(symbol.kind) +
    ' ' +
    String(symbol.range.start.line + 1) +
    ':' +
    String(symbol.range.start.character + 1);
  const children = symbol.children ?? [];
  return [line, ...children.map((child) => formatDocumentSymbol(child, depth + 1))]
    .filter(Boolean)
    .join('\n');
}

function formatDocumentSymbols(symbols: DocumentSymbol[]): string {
  return symbols.length > 0
    ? symbols.map((symbol) => formatDocumentSymbol(symbol)).join('\n')
    : 'No document symbols.';
}

export const LSPGoToDefinitionTool = buildTool<PositionInput, string>({
  name: 'LSPGoToDefinition',
  source: 'lsp',
  inputSchema: positionSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  async call(input, context) {
    const data = await withLsp(context, input.file, async () =>
      formatLocations(
        await context.lspManager!.goToDefinition(
          input.file,
          input.line,
          input.character,
        ),
      ),
    );
    return { data };
  },
  mapResult(data, toolUseId) {
    return { toolUseId, content: data };
  },
});

export const LSPFindReferencesTool = buildTool<PositionInput, string>({
  name: 'LSPFindReferences',
  source: 'lsp',
  inputSchema: positionSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  async call(input, context) {
    const data = await withLsp(context, input.file, async () =>
      formatLocations(
        await context.lspManager!.findReferences(
          input.file,
          input.line,
          input.character,
        ),
      ),
    );
    return { data };
  },
  mapResult(data, toolUseId) {
    return { toolUseId, content: data };
  },
});

export const LSPDiagnosticsTool = buildTool<FileInput, string>({
  name: 'LSPDiagnostics',
  source: 'lsp',
  inputSchema: fileSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  async call(input, context) {
    const data = await withLsp(context, input.file, async () =>
      formatDiagnostics(await context.lspManager!.getDiagnostics(input.file)),
    );
    return { data };
  },
  mapResult(data, toolUseId) {
    return { toolUseId, content: data };
  },
});

export const LSPHoverTool = buildTool<PositionInput, string>({
  name: 'LSPHover',
  source: 'lsp',
  inputSchema: positionSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  async call(input, context) {
    const data = await withLsp(context, input.file, async () =>
      formatHover(
        await context.lspManager!.hover(
          input.file,
          input.line,
          input.character,
        ),
      ),
    );
    return { data };
  },
  mapResult(data, toolUseId) {
    return { toolUseId, content: data };
  },
});

export const LSPDocumentSymbolsTool = buildTool<FileInput, string>({
  name: 'LSPDocumentSymbols',
  source: 'lsp',
  inputSchema: fileSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  async call(input, context) {
    const data = await withLsp(context, input.file, async () =>
      formatDocumentSymbols(
        await context.lspManager!.documentSymbols(input.file),
      ),
    );
    return { data };
  },
  mapResult(data, toolUseId) {
    return { toolUseId, content: data };
  },
});

export function createLspTools(): Tool[] {
  return [
    LSPGoToDefinitionTool,
    LSPFindReferencesTool,
    LSPDiagnosticsTool,
    LSPHoverTool,
    LSPDocumentSymbolsTool,
  ];
}
