import { diagnosticProgress, progressHookFailed, type EventOptions } from './diagnostics.ts';
import { isAbsolute } from 'node:path';
import { PicPatchCancelledError, PicPatchRuntimeError, PicPatchUsageError } from './errors.ts';

export function absolutePath(path: unknown): asserts path is string {
  if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')) throw new PicPatchUsageError('INVALID_REQUEST', 'Supply an absolute filesystem path.');
}
export function checkSignal(signal?: AbortSignal): void {
  if (signal?.aborted) throw new PicPatchCancelledError('The operation was cancelled.');
}
export function validateOperation(options: unknown, extraKeys: string[] = []): void {
  if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => !['signal', 'onProgress', 'onEvent', ...extraKeys].includes(key))) throw new PicPatchUsageError('INVALID_REQUEST', 'Invalid operation options.');
  const value = options as { signal?: unknown; onProgress?: unknown; onEvent?: unknown };
  if ((value.signal !== undefined && !(value.signal instanceof AbortSignal)) || (value.onProgress !== undefined && typeof value.onProgress !== 'function') || (value.onEvent !== undefined && typeof value.onEvent !== 'function')) throw new PicPatchUsageError('INVALID_REQUEST', 'Invalid cancellation signal or progress callback.');
}
export function emitProgress<T extends { stage: string }>(options: EventOptions & { signal?: AbortSignal; onProgress?: (event: T) => void }, event: T): void {
  checkSignal(options.signal);
  diagnosticProgress(options, event);
  try {
    const returned: unknown = options.onProgress?.(event);
    void Promise.resolve(returned).catch(() => progressHookFailed(options));
  } catch { progressHookFailed(options); }
  checkSignal(options.signal);
}
export function timeBudget(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) <= 0 || (value as number) > 1_000_000_000) throw new PicPatchUsageError('INVALID_REQUEST', 'Timeout must be positive whole milliseconds within the timer range.');
  return value as number;
}

/** A deadline stops new work; the action still owns pending I/O until it settles. */
export async function withDeadline<T>(signal: AbortSignal | undefined, milliseconds: number, message: string, action: (signal: AbortSignal) => Promise<T>): Promise<T> {
  checkSignal(signal);
  const deadline = new AbortController();
  const combined = AbortSignal.any([deadline.signal, ...(signal ? [signal] : [])]);
  const timer = setTimeout(() => deadline.abort(), milliseconds);
  try {
    const result = await action(combined);
    checkSignal(combined);
    return result;
  } catch (cause) {
    checkSignal(signal);
    if (deadline.signal.aborted) throw new PicPatchRuntimeError('TIMEOUT', message, { cause });
    throw cause;
  } finally { clearTimeout(timer); }
}
