import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  loadMcpServersFromEnv,
  loadProjectMcpServers,
  parseMcpConfigDocument,
  validateMcpServersConfig,
} from '../src/config/mcp-config';

test('MCP config accepts stdio, http, sse, and trust levels', () => {
  const config = validateMcpServersConfig({
    local: {
      command: 'node',
      args: ['server.mjs'],
      env: { TOKEN: 'secret' },
      trust: 'trusted',
    },
    docs: {
      type: 'http',
      url: 'https://mcp.example.com',
      headers: { Authorization: 'Bearer token' },
      trust: 'ask',
    },
    events: {
      type: 'sse',
      url: 'https://mcp.example.com/sse',
      trust: 'blocked',
    },
  });

  assert.equal(config.local?.type, 'stdio');
  assert.equal(config.docs?.type, 'http');
  assert.equal(config.events?.type, 'sse');
  assert.equal(config.events?.trust, 'blocked');
});

test('MCP config rejects malformed server definitions', () => {
  assert.throws(
    () => validateMcpServersConfig({ bad: { type: 'stdio', args: [] } }),
    /command/,
  );
  assert.throws(
    () => validateMcpServersConfig({ bad: { type: 'http', url: 'nope' } }),
    /absolute URL/,
  );
  assert.throws(
    () =>
      validateMcpServersConfig({ bad: { command: 'node', trust: 'maybe' } }),
    /trusted, ask, or blocked/,
  );
});

test('MCP config reads server env JSON and project config files', () => {
  const fromEnv = loadMcpServersFromEnv({
    MCP_SERVERS: JSON.stringify({
      mcpServers: {
        envServer: { command: 'node', trust: 'trusted' },
      },
    }),
  } as NodeJS.ProcessEnv);
  assert.equal(fromEnv.envServer?.trust, 'trusted');

  const root = mkdtempSync(join(tmpdir(), 'colorful-mcp-config-'));
  const cwd = join(root, 'packages', 'app');
  mkdirSync(join(root, '.colorful-code'), { recursive: true });
  mkdirSync(cwd, { recursive: true });
  try {
    writeFileSync(
      join(root, '.colorful-code', 'mcp.json'),
      JSON.stringify({
        mcpServers: {
          projectServer: { command: 'node', trust: 'ask' },
        },
      }),
    );
    const fromProject = loadProjectMcpServers(cwd);
    assert.equal(fromProject.projectServer?.trust, 'ask');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('MCP config document also accepts a direct server map', () => {
  const config = parseMcpConfigDocument({
    direct: { command: 'node', trust: 'trusted' },
  });

  assert.equal(config.direct?.trust, 'trusted');
});
