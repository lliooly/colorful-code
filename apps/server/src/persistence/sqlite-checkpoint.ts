import type { Database } from 'bun:sqlite';

export type WalCheckpointResult = Readonly<{
  status: 'completed' | 'incomplete' | 'interrupted';
  sqliteBusy: boolean;
  logFrames: number;
  checkpointedFrames: number;
  remainingFrames: number;
}>;

export type WalCheckpointErrorCode =
  | 'checkpoint_failed'
  | 'invalid_checkpoint_result';

export class WalCheckpointError extends Error {
  readonly code: WalCheckpointErrorCode;

  constructor(code: WalCheckpointErrorCode) {
    super(`SQLite WAL checkpoint rejected (${code})`);
    this.name = 'WalCheckpointError';
    this.code = code;
  }
}

type CheckpointConnection = Pick<Database, 'query'>;

function interruptedResult(): WalCheckpointResult {
  return Object.freeze({
    status: 'interrupted',
    sqliteBusy: false,
    logFrames: 0,
    checkpointedFrames: 0,
    remainingFrames: 0,
  });
}

export function checkpointWal(
  database: CheckpointConnection,
  signal?: AbortSignal,
): WalCheckpointResult {
  if (signal?.aborted === true) return interruptedResult();

  let row: { busy: unknown; log: unknown; checkpointed: unknown } | null;
  try {
    row = database
      .query<
        { busy: unknown; log: unknown; checkpointed: unknown },
        []
      >('PRAGMA wal_checkpoint(PASSIVE)')
      .get();
  } catch {
    throw new WalCheckpointError('checkpoint_failed');
  }

  const keys = row === null ? [] : Object.keys(row).sort();
  if (
    row === null ||
    keys.length !== 3 ||
    keys[0] !== 'busy' ||
    keys[1] !== 'checkpointed' ||
    keys[2] !== 'log' ||
    !Number.isInteger(row.busy) ||
    (row.busy !== 0 && row.busy !== 1) ||
    !Number.isInteger(row.log) ||
    !Number.isInteger(row.checkpointed) ||
    (row.log as number) < -1 ||
    (row.checkpointed as number) < -1 ||
    (row.log === -1) !== (row.checkpointed === -1) ||
    (row.checkpointed as number) > (row.log as number)
  ) {
    throw new WalCheckpointError('invalid_checkpoint_result');
  }

  const logFrames = row.log === -1 ? 0 : (row.log as number);
  const checkpointedFrames =
    row.checkpointed === -1 ? 0 : (row.checkpointed as number);
  const completed = logFrames === checkpointedFrames;
  return Object.freeze({
    status: completed ? 'completed' : 'incomplete',
    sqliteBusy: row.busy === 1,
    logFrames,
    checkpointedFrames,
    remainingFrames: logFrames - checkpointedFrames,
  });
}
