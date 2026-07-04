import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { arch, platform } from 'node:process';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = resolve(scriptDir, '../../..');
const serverDir = resolve(workspaceRoot, 'apps/server');
const outputDir = resolve(workspaceRoot, 'apps/desktop/src-tauri/binaries');

const targets = {
  arm64: {
    bun: 'bun-darwin-arm64',
    tauri: 'aarch64-apple-darwin',
  },
  x64: {
    bun: 'bun-darwin-x64',
    tauri: 'x86_64-apple-darwin',
  },
};

if (platform !== 'darwin') {
  throw new Error('Colorful Code desktop packaging is currently macOS-only.');
}

const target = targets[arch];
if (!target) {
  throw new Error(`Unsupported macOS architecture for sidecar build: ${arch}`);
}

const optionalNestDependencies = [
  '@nestjs/microservices',
  '@nestjs/platform-express',
  '@nestjs/websockets/socket-module',
  '@fastify/static',
  '@fastify/view',
  'class-transformer',
  'class-validator',
];

mkdirSync(outputDir, { recursive: true });

execFileSync(
  'pnpm',
  [
    '--filter',
    '@colorful-code/tool-runtime',
    '--filter',
    '@colorful-code/prompts',
    'build',
  ],
  {
    cwd: workspaceRoot,
    stdio: 'inherit',
  },
);

const outfile = resolve(outputDir, `colorful-code-server-${target.tauri}`);

execFileSync(
  'bun',
  [
    'build',
    '--compile',
    `--target=${target.bun}`,
    'src/main.ts',
    '--outfile',
    outfile,
    ...optionalNestDependencies.flatMap((dependency) => [
      '--external',
      dependency,
    ]),
  ],
  {
    cwd: serverDir,
    stdio: 'inherit',
  },
);
