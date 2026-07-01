import type { JsonObject } from '../core/tool.js';

export type LspLanguage =
  | 'typescript'
  | 'rust'
  | 'go'
  | 'python'
  | 'java'
  | 'csharp'
  | 'cpp'
  | 'ruby'
  | 'php'
  | (string & {});

export type LspServerConfig = {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  language: LspLanguage;
  fileExtensions: string[];
  initializationOptions?: JsonObject;
};

export type Position = {
  line: number;
  character: number;
};

export type Range = {
  start: Position;
  end: Position;
};

export type Location = {
  uri: string;
  range: Range;
};

export type Diagnostic = {
  range: Range;
  message: string;
  severity?: number;
  source?: string;
  code?: string | number;
};

export type Hover = {
  contents: unknown;
  range?: Range;
};

export type DocumentSymbol = {
  name: string;
  kind: number;
  range: Range;
  selectionRange: Range;
  detail?: string;
  children?: DocumentSymbol[];
};

export type SymbolInformation = {
  name: string;
  kind: number;
  location: Location;
  containerName?: string;
};

export type LspServerMetadata = {
  name: string;
  language: LspLanguage;
  fileExtensions: string[];
  capabilities?: JsonObject;
};

export type LspServerConnection =
  | {
      name: string;
      type: 'connected';
      language: LspLanguage;
      config: LspServerConfig;
      capabilities: JsonObject;
      metadata: LspServerMetadata;
      close?: () => Promise<void>;
    }
  | {
      name: string;
      type: 'failed';
      language: LspLanguage;
      config: LspServerConfig;
      error: string;
    };

export type LspManager = {
  initialize(workspaceRoot: string): Promise<LspServerConnection[]>;
  goToDefinition(
    file: string,
    line: number,
    character: number,
  ): Promise<Location[]>;
  findReferences(
    file: string,
    line: number,
    character: number,
  ): Promise<Location[]>;
  getDiagnostics(file: string): Promise<Diagnostic[]>;
  hover(file: string, line: number, character: number): Promise<Hover | null>;
  documentSymbols(file: string): Promise<DocumentSymbol[]>;
  workspaceSymbol(query: string): Promise<SymbolInformation[]>;
  didChange(file: string, content: string): Promise<void>;
  close(): Promise<void>;
};
