import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import {
  ToolRegistry,
  ToolRunner,
  SdkMcpManager,
  MCPTool,
  createMcpRuntimeTools,
  createRuntimeContext,
  normalizeMcpName,
  buildMcpToolName,
  type McpManager,
} from '../index.js';

const fakeManager: McpManager = {
  async connectAll() {
    return [
      {
        name: 'docs server',
        type: 'connected',
        config: { type: 'stdio', command: 'fake-docs', args: [] },
        tools: [
          {
            server: 'docs server',
            name: 'search docs',
            description: 'Search project docs',
            inputSchema: {
              type: 'object',
              properties: { query: { type: 'string' } },
            },
            annotations: { readOnlyHint: true },
          },
        ],
        resources: [
          {
            server: 'docs server',
            uri: 'docs://intro',
            name: 'Intro',
            mimeType: 'text/plain',
          },
        ],
      },
    ];
  },
  async callTool(server, tool, args) {
    return {
      content: [
        { type: 'text', text: server + '/' + tool + ':' + String(args.query) },
      ],
    };
  },
  async listResources() {
    return [
      {
        server: 'docs server',
        uri: 'docs://intro',
        name: 'Intro',
        mimeType: 'text/plain',
      },
    ];
  },
  async readResource(server, uri) {
    return {
      contents: [
        { server, uri, mimeType: 'text/plain', text: 'hello from ' + uri },
      ],
    };
  },
};

test('MCP names are normalized into stable fully-qualified tool names', () => {
  assert.equal(normalizeMcpName('docs server'), 'docs_server');
  assert.equal(
    buildMcpToolName('docs server', 'search docs'),
    'mcp__docs_server__search_docs',
  );
});

test('createMcpRuntimeTools wraps discovered MCP tools into registry tools', async () => {
  const tools = await createMcpRuntimeTools(fakeManager);
  const registry = new ToolRegistry(tools);
  const runner = new ToolRunner(
    registry,
    createRuntimeContext({ mcpManager: fakeManager }),
  );

  const result = await runner.run({
    id: 'mcp-1',
    name: 'mcp__docs_server__search_docs',
    input: { query: 'runtime' },
  });

  assert.equal(result.isError, undefined);
  assert.equal(result.content, 'docs server/search docs:runtime');
  assert.equal(
    registry.get('mcp__docs_server__search_docs')?.isReadOnly({}),
    true,
  );
});

test('MCP resource tools use the manager when one is configured', async () => {
  const tools = await createMcpRuntimeTools(fakeManager);
  const runner = new ToolRunner(
    new ToolRegistry(tools),
    createRuntimeContext({ mcpManager: fakeManager }),
  );

  const listed = await runner.run({
    id: 'list',
    name: 'ListMcpResourcesTool',
    input: { server: 'docs server' },
  });
  const read = await runner.run({
    id: 'read',
    name: 'ReadMcpResourceTool',
    input: { server: 'docs server', uri: 'docs://intro' },
  });

  assert.match(listed.content, /docs server\s+docs:\/\/intro\s+Intro/);
  assert.equal(read.content, 'hello from docs://intro');
});

test('MCPTool uses mcpManager.callTool before the legacy provider fallback', async () => {
  let providerCalled = false;
  const runner = new ToolRunner(
    new ToolRegistry([MCPTool]),
    createRuntimeContext({
      mcpManager: fakeManager,
      mcpToolProvider: async () => {
        providerCalled = true;
        return 'provider fallback';
      },
    }),
  );

  const result = await runner.run({
    id: 'mcp-manager',
    name: 'MCPTool',
    input: { server: 'docs server', tool: 'search docs', args: { query: 'api' } },
  });

  assert.equal(providerCalled, false);
  assert.equal(result.isError, undefined);
  assert.equal(result.content, 'docs server/search docs:api');
});

test('MCPTool reports an error when neither manager nor provider is configured', async () => {
  const runner = new ToolRunner(
    new ToolRegistry([MCPTool]),
    createRuntimeContext(),
  );

  const result = await runner.run({
    id: 'mcp-missing',
    name: 'MCPTool',
    input: { server: 'docs', tool: 'search', args: { query: 'api' } },
  });

  assert.equal(result.isError, true);
  assert.match(result.content, /MCP provider not configured/);
});

test('SdkMcpManager connects to a stdio server and exposes tools and resources', async () => {
  const manager = new SdkMcpManager({
    fixture: {
      type: 'stdio',
      command: process.execPath,
      args: [
        join(process.cwd(), 'src/__tests__/fixtures/mcp-stdio-server.mjs'),
      ],
    },
  });

  try {
    const tools = await createMcpRuntimeTools(manager);
    const runner = new ToolRunner(
      new ToolRegistry(tools),
      createRuntimeContext({ mcpManager: manager }),
    );

    const called = await runner.run({
      id: 'call',
      name: 'mcp__fixture__echo',
      input: { message: 'hello' },
    });
    const listed = await runner.run({
      id: 'list',
      name: 'ListMcpResourcesTool',
      input: { server: 'fixture' },
    });
    const read = await runner.run({
      id: 'read',
      name: 'ReadMcpResourceTool',
      input: { server: 'fixture', uri: 'fixture://intro' },
    });

    assert.equal(called.content, 'echo:hello');
    assert.match(listed.content, /fixture\s+fixture:\/\/intro\s+Intro/);
    assert.equal(read.content, 'resource:fixture://intro');
  } finally {
    await manager.close();
  }
});
