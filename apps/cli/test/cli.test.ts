import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { buildCreateSessionBody, parseCliArgs } from '../src/args';
import { parseSseChunk } from '../src/sse';

test('parseCliArgs accepts cwd, prompt, and a BYO provider key', () => {
  const options = parseCliArgs(
    [
      '--api-key',
      'sk-test',
      '--cwd',
      '/tmp/project',
      '--prompt',
      'list files',
      '--protocol',
      'openai',
      '--model',
      'gpt-test',
    ],
    {},
  );

  assert.deepEqual(options, {
    apiBaseUrl: 'http://127.0.0.1:3367',
    apiKey: 'sk-test',
    cwd: '/tmp/project',
    prompt: 'list files',
    protocol: 'openai',
    model: 'gpt-test',
  });
});

test('buildCreateSessionBody sends API keys through the custom model path', () => {
  const body = buildCreateSessionBody({
    apiBaseUrl: 'http://127.0.0.1:3367',
    apiKey: 'sk-test',
    cwd: '/tmp/project',
    prompt: 'hello',
    protocol: 'anthropic',
    model: 'claude-test',
  });

  assert.deepEqual(body, {
    cwd: '/tmp/project',
    workspaceRoots: ['/tmp/project'],
    model: {
      preset: 'custom',
      apiKey: 'sk-test',
      protocol: 'anthropic',
      model: 'claude-test',
    },
  });
});

test('parseCliArgs accepts an MCP config path', () => {
  const options = parseCliArgs(
    ['--cwd', '/tmp/project', '--mcp-config', '/tmp/mcp.json', 'hello'],
    {},
  );

  assert.equal(options.mcpConfigPath, '/tmp/mcp.json');
  assert.equal(options.prompt, 'hello');
});

test('buildCreateSessionBody includes MCP servers when loaded by the CLI', () => {
  const body = buildCreateSessionBody({
    apiBaseUrl: 'http://127.0.0.1:3367',
    cwd: '/tmp/project',
    prompt: 'hello',
    mcpServers: {
      fixture: {
        type: 'stdio',
        command: 'node',
        args: ['server.mjs'],
        trust: 'ask',
      },
    },
  });

  assert.deepEqual(body.mcpServers, {
    fixture: {
      type: 'stdio',
      command: 'node',
      args: ['server.mjs'],
      trust: 'ask',
    },
  });
});

test('parseSseChunk returns JSON data events and preserves incomplete frames', () => {
  const first = parseSseChunk('', 'event: message\n');
  assert.deepEqual(first.events, []);
  assert.equal(first.remainder, 'event: message\n');

  const second = parseSseChunk(
    first.remainder,
    'data: {"type":"message","content":"hi"}\n\n',
  );

  assert.deepEqual(second.events, [{ type: 'message', content: 'hi' }]);
  assert.equal(second.remainder, '');
});
