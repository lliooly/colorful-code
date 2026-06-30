import { setTimeout as delay } from 'node:timers/promises';

export type ProviderRetryOptions = {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  signal?: AbortSignal;
};

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 250;
const DEFAULT_MAX_DELAY_MS = 2_000;

export async function* runWithProviderRetry<T>(
  openStream: () => AsyncIterable<T> | Promise<AsyncIterable<T>>,
  options: ProviderRetryOptions = {}
): AsyncIterable<T> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;

  for (let attempt = 1; ; attempt += 1) {
    let producedOutput = false;
    try {
      const stream = await openStream();
      for await (const event of stream) {
        producedOutput = true;
        yield event;
      }
      return;
    } catch (error) {
      if (
        producedOutput ||
        options.signal?.aborted ||
        attempt >= maxAttempts ||
        !isTransientProviderError(error)
      ) {
        throw error;
      }
      await delay(backoffMs(attempt, baseDelayMs, maxDelayMs), undefined, {
        signal: options.signal
      });
    }
  }
}

function backoffMs(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number
): number {
  return Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
}

function isTransientProviderError(error: unknown): boolean {
  const status = readStatus(error);
  if (status === 429) {
    return true;
  }
  return status !== undefined && status >= 500 && status < 600;
}

function readStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }
  const record = error as Record<string, unknown>;
  const status = record.status ?? record.statusCode;
  return typeof status === 'number' ? status : undefined;
}
