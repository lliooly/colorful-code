import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const server = new Server(
  { name: 'colorful-fixture', version: '0.0.0' },
  { capabilities: { tools: {}, resources: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'echo',
      description: 'Echo a message',
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
      uri: 'fixture://intro',
      name: 'Intro',
      mimeType: 'text/plain',
    },
  ],
}));

server.setRequestHandler(ReadResourceRequestSchema, async ({ params }) => ({
  contents: [
    {
      uri: params.uri,
      mimeType: 'text/plain',
      text: 'resource:' + params.uri,
    },
  ],
}));

await server.connect(new StdioServerTransport());
