import {
  DataDirectoryInstanceLock,
  DataDirectoryLockConflictError,
} from '../../src/runtime/data-directory-instance-lock';

const [dataDirectory] = process.argv.slice(2);

try {
  const lock = await DataDirectoryInstanceLock.acquire(dataDirectory!);
  process.stdout.write(
    `${JSON.stringify({ status: 'ready', pid: process.pid })}\n`,
  );

  let releasing = false;
  const release = async () => {
    if (releasing) return;
    releasing = true;
    let exitCode = 0;
    try {
      await lock.release();
      await writeOutput(
        process.stdout,
        `${JSON.stringify({ status: 'released' })}\n`,
      );
    } catch {
      exitCode = 1;
      await writeOutput(
        process.stderr,
        'Failed to release data directory lock\n',
      );
    } finally {
      process.exit(exitCode);
    }
  };
  process.once('SIGTERM', () => void release());
  process.once('SIGINT', () => void release());
  process.stdin.resume();
} catch (error) {
  if (error instanceof DataDirectoryLockConflictError) {
    process.stdout.write(
      `${JSON.stringify({ status: 'conflict', message: error.message })}\n`,
    );
    process.stderr.write(`${error.message}\n`);
    process.exit(2);
  }
  throw error;
}

function writeOutput(
  stream: NodeJS.WriteStream,
  output: string,
): Promise<void> {
  return new Promise((resolve) => stream.write(output, resolve));
}
