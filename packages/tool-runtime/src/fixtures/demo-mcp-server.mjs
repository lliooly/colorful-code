import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const server = new Server(
  { name: 'colorful-demo', version: '1.0.0' },
  { capabilities: { tools: {}, resources: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'echo',
      description: 'Echo a message for MCP smoke tests and demos.',
      inputSchema: {
        type: 'object',
        properties: { message: { type: 'string' } },
      },
      annotations: { readOnlyHint: true },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async ({ params }) => ({
  content: [
    {
      type: 'text',
      text: 'echo:' + String(params.arguments?.message ?? ''),
    },
  ],
}));

server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [
    {
      uri: 'demo://intro',
      name: 'Demo intro',
      mimeType: 'text/plain',
      description: 'A tiny built-in resource exposed by the demo MCP server.',
    },
  ],
}));

server.setRequestHandler(ReadResourceRequestSchema, async ({ params }) => ({
  contents: [
    {
      uri: params.uri,
      mimeType: 'text/plain',
      text: 'Colorful Code demo MCP resource: ' + params.uri,
    },
  ],
}));

await server.connect(new StdioServerTransport());
