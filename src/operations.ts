import { isAbsolute } from 'node:path';
import { PicPatchCancelledError, PicPatchRuntimeError, PicPatchUsageError } from './errors.ts';

export function absolutePath(path: unknown): asserts path is string {
  if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')) throw new PicPatchUsageError('INVALID_REQUEST', 'Supply an absolute filesystem path.');
}
export function checkSignal(signal?: AbortSignal): void {
  if (signal?.aborted) throw new PicPatchCancelledError('The operation was cancelled.');
}
export function validateOperation(options: unknown, extraKeys: string[] = []): void {
  if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => !['signal', 'onProgress', ...extraKeys].includes(key))) throw new PicPatchUsageError('INVALID_REQUEST', 'Invalid operation options.');
  const value = options as { signal?: unknown; onProgress?: unknown };
  if ((value.signal !== undefined && !(value.signal instanceof AbortSignal)) || (value.onProgress !== undefined && typeof value.onProgress !== 'function')) throw new PicPatchUsageError('INVALID_REQUEST', 'Invalid cancellation signal or progress callback.');
}
export function emitProgress<T>(options: { signal?: AbortSignal; onProgress?: (event: T) => void }, event: T): void {
  checkSignal(options.signal);
  try { options.onProgress?.(event); }
  catch (cause) { throw new PicPatchRuntimeError('CALLBACK_FAILED', 'Progress callback failed.', { cause }); }
  checkSignal(options.signal);
}
export function timeBudget(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) <= 0 || (value as number) > 1_000_000_000) throw new PicPatchUsageError('INVALID_REQUEST', 'Timeout must be positive whole milliseconds within the timer range.');
  return value as number;
}
