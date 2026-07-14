import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { verifyProductionBuild } from './verify-production-build';

const projectDirectory = join(import.meta.dir, '..');
const outputDirectory = join(projectDirectory, 'dist');

rmSync(outputDirectory, { recursive: true, force: true });

const build = Bun.spawnSync(['pnpm', 'exec', 'nest', 'build'], {
  cwd: projectDirectory,
  stdout: 'inherit',
  stderr: 'inherit',
});
if (!build.success) {
  process.exit(build.exitCode);
}

verifyProductionBuild(outputDirectory);
