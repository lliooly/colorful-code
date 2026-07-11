import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { Database } from 'bun:sqlite';

export type DatabaseBackupResult = {
  databasePath: string;
  manifestPath: string;
  integrityCheck: string;
  foreignKeyViolations: number;
  sha256: string;
};

function sqliteString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function defaultTimestamp(): string {
  return new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
}

export function backupDatabase(options: {
  sourcePath: string;
  outputDirectory: string;
  timestamp?: string;
}): DatabaseBackupResult {
  const sourcePath = resolve(options.sourcePath);
  const outputDirectory = resolve(options.outputDirectory);
  const timestamp = options.timestamp ?? defaultTimestamp();
  const finalDirectory = join(outputDirectory, timestamp);
  const temporaryDirectory = join(
    outputDirectory,
    `.${timestamp}.tmp-${process.pid}`,
  );
  if (existsSync(finalDirectory) || existsSync(temporaryDirectory)) {
    throw new Error(`Refusing to overwrite existing backup: ${finalDirectory}`);
  }

  mkdirSync(outputDirectory, { recursive: true });
  mkdirSync(temporaryDirectory);
  const databasePath = join(temporaryDirectory, 'colorful-code.db');
  let source: Database | undefined;
  let backup: Database | undefined;
  try {
    source = new Database(sourcePath);
    const sourceCheck = source
      .query<{ quick_check: string }, []>('PRAGMA quick_check')
      .get()?.quick_check;
    if (sourceCheck !== 'ok') {
      throw new Error(
        `Source database quick_check failed: ${sourceCheck ?? 'unknown'}`,
      );
    }
    source.exec(`VACUUM INTO ${sqliteString(databasePath)}`);
    source.close();
    source = undefined;

    backup = new Database(databasePath, { readonly: true });
    const integrityCheck =
      backup
        .query<{ integrity_check: string }, []>('PRAGMA integrity_check')
        .get()?.integrity_check ?? 'missing';
    const foreignKeyViolations = backup
      .query('PRAGMA foreign_key_check')
      .all().length;
    backup.close();
    backup = undefined;
    if (integrityCheck !== 'ok' || foreignKeyViolations !== 0) {
      throw new Error(
        `Backup verification failed: integrity=${integrityCheck}, foreignKeys=${foreignKeyViolations}`,
      );
    }

    const bytes = readFileSync(databasePath);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const manifestPath = join(temporaryDirectory, 'manifest.json');
    writeFileSync(
      manifestPath,
      `${JSON.stringify(
        {
          formatVersion: 1,
          sourcePath,
          sourceFile: basename(sourcePath),
          createdAt: new Date().toISOString(),
          sizeBytes: statSync(databasePath).size,
          sha256,
          integrityCheck,
          foreignKeyViolations,
        },
        null,
        2,
      )}\n`,
      { encoding: 'utf8', flag: 'wx' },
    );
    renameSync(temporaryDirectory, finalDirectory);
    return {
      databasePath: join(finalDirectory, 'colorful-code.db'),
      manifestPath: join(finalDirectory, 'manifest.json'),
      integrityCheck,
      foreignKeyViolations,
      sha256,
    };
  } catch (error) {
    backup?.close();
    source?.close();
    rmSync(temporaryDirectory, { recursive: true, force: true });
    throw error;
  }
}

if (import.meta.main) {
  const sourcePath = Bun.argv[2] ?? './data/colorful-code.db';
  const outputDirectory = Bun.argv[3] ?? './.backups';
  const result = backupDatabase({ sourcePath, outputDirectory });
  console.log(JSON.stringify(result, null, 2));
}
