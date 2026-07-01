import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  autoDetectLspServers,
  loadLspServersFromEnv,
  loadProjectLspServers,
  mergeLspServers,
  validateLspServersConfig,
} from '../src/config/lsp-config';

test('LSP config accepts stdio language server definitions', () => {
  const config = validateLspServersConfig({
    typescript: {
      command: 'typescript-language-server',
      args: ['--stdio'],
      env: { NODE_OPTIONS: '--max-old-space-size=4096' },
      language: 'typescript',
      fileExtensions: ['.ts', '.tsx'],
      initializationOptions: { preferences: { includePackageJsonAutoImports: 'on' } },
    },
  });

  assert.equal(config.typescript?.language, 'typescript');
  assert.deepEqual(config.typescript?.fileExtensions, ['.ts', '.tsx']);
});

test('LSP config rejects malformed server definitions', () => {
  assert.throws(
    () =>
      validateLspServersConfig({
        bad: { command: '', language: 'typescript', fileExtensions: ['.ts'] },
      }),
    /command/,
  );
  assert.throws(
    () =>
      validateLspServersConfig({
        bad: { command: 'tsls', language: 'typescript', fileExtensions: [] },
      }),
    /fileExtensions/,
  );
});

test('LSP config reads env JSON and project config files', () => {
  const fromEnv = loadLspServersFromEnv({
    LSP_SERVERS: JSON.stringify({
      lspServers: {
        ts: {
          command: 'typescript-language-server',
          args: ['--stdio'],
          language: 'typescript',
          fileExtensions: ['.ts'],
        },
      },
    }),
  } as NodeJS.ProcessEnv);
  assert.equal(fromEnv.ts?.command, 'typescript-language-server');

  const root = mkdtempSync(join(tmpdir(), 'colorful-lsp-config-'));
  const cwd = join(root, 'packages', 'app');
  mkdirSync(join(root, '.colorful-code'), { recursive: true });
  mkdirSync(cwd, { recursive: true });
  try {
    writeFileSync(
      join(root, '.colorful-code', 'lsp.json'),
      JSON.stringify({
        lspServers: {
          pyright: {
            command: 'pyright-langserver',
            args: ['--stdio'],
            language: 'python',
            fileExtensions: ['.py'],
          },
        },
      }),
    );
    const fromProject = loadProjectLspServers(cwd);
    assert.equal(fromProject.pyright?.language, 'python');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('autoDetectLspServers detects TypeScript only when the binary is available', () => {
  const root = mkdtempSync(join(tmpdir(), 'colorful-lsp-detect-'));
  try {
    writeFileSync(join(root, 'package.json'), '{}');
    const config = autoDetectLspServers(root, {
      which(command) {
        return command === 'typescript-language-server'
          ? '/usr/local/bin/typescript-language-server'
          : undefined;
      },
    });

    assert.equal(config.typescript?.command, 'typescript-language-server');

    const missing = autoDetectLspServers(root, { which: () => undefined });
    assert.deepEqual(missing, {});
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('mergeLspServers lets later configs override earlier configs', () => {
  const merged = mergeLspServers(
    {
      typescript: {
        command: 'auto',
        language: 'typescript',
        fileExtensions: ['.ts'],
      },
    },
    {
      typescript: {
        command: 'project',
        args: ['--stdio'],
        language: 'typescript',
        fileExtensions: ['.ts', '.tsx'],
      },
    },
  );

  assert.equal(merged.typescript?.command, 'project');
  assert.deepEqual(merged.typescript?.fileExtensions, ['.ts', '.tsx']);
});
