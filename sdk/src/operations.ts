import { storageScope, storageCancellation } from './storage.ts';
import type { ProgressEvent } from './types.ts';
import { diagnosticProgress, progressHookFailed, type EventOptions } from './diagnostics.ts';
import { isAbsolute } from 'node:path';
import { PicPatchSdkError } from './errors.ts';

export function absolutePath(path: unknown): asserts path is string {
  if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')) throw new PicPatchSdkError('INVALID_REQUEST', 'Supply an absolute filesystem path.');
}
export function checkSignal(signal?: AbortSignal): void {
  if (signal?.aborted) throw storageCancellation() ?? new PicPatchSdkError('CANCELLED', 'The operation was cancelled.');
}
export function validateOperation(options: unknown, extraKeys: string[] = []): void {
  if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => !['signal', 'debug', 'caller', 'onProgress', 'onEvent', 'timeoutMs', ...extraKeys].includes(key))) throw new PicPatchSdkError('INVALID_REQUEST', 'Invalid operation options.');
  const caller = (options as { caller?: unknown }).caller;
  if (caller !== undefined && (!caller || typeof caller !== 'object' || Array.isArray(caller) || Object.keys(caller).some(key => !['name', 'version'].includes(key)) || ['name', 'version'].some(key => typeof (caller as Record<string, unknown>)[key] !== 'string' || !(caller as Record<string, string>)[key]?.trim()))) throw new PicPatchSdkError('INVALID_REQUEST', 'Invalid caller identity.');
  timeBudget((options as { timeoutMs?: unknown }).timeoutMs, 1_800_000);
  const value = options as { signal?: unknown; onProgress?: unknown; onEvent?: unknown };
  if ((value.signal !== undefined && !(value.signal instanceof AbortSignal)) || (value.onProgress !== undefined && typeof value.onProgress !== 'function') || (value.onEvent !== undefined && typeof value.onEvent !== 'function')) throw new PicPatchSdkError('INVALID_REQUEST', 'Invalid cancellation signal or progress callback.');
}
export function emitProgress<T extends { stage: string; completed?: number; total?: number }>(options: EventOptions & { signal?: AbortSignal; onProgress?: (event: ProgressEvent) => void }, event: T): void {
  checkSignal(options.signal);
  if (!diagnosticProgress(options, event)) { checkSignal(options.signal); return; }
  try {
    const returned: unknown = options.onProgress?.({ type: 'progress', stage: event.stage, completed: event.completed!, total: event.total! });
    void Promise.resolve(returned).catch(() => progressHookFailed(options));
  } catch { progressHookFailed(options); }
  checkSignal(options.signal);
}
export function timeBudget(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) <= 0 || (value as number) > 1_000_000_000) throw new PicPatchSdkError('INVALID_REQUEST', 'Timeout must be positive whole milliseconds within the timer range.');
  return value as number;
}

/** A deadline stops new work; the action still owns pending I/O until it settles. */
export async function withDeadline<T>(signal: AbortSignal | undefined, milliseconds: number, message: string, action: (signal: AbortSignal) => Promise<T>): Promise<T> {
  checkSignal(signal);
  const deadline = new AbortController();
  const combined = AbortSignal.any([deadline.signal, ...(signal ? [signal] : [])]);
  const timer = setTimeout(() => deadline.abort(), milliseconds);
  try {
    const result = await storageScope(combined, () => action(combined));
    checkSignal(combined);
    return result;
  } catch (cause) {
    // Cancellation cannot erase evidence that a writer or its private files remain unsettled.
    if (cause instanceof PicPatchSdkError && cause.kind !== 'cancelled' && (cause.effect === 'unknown' || cause.code === 'TERMINATION_FAILED' || cause.code === 'CLEANUP_FAILED' || cause.details.recoveryDirectory !== undefined)) throw cause;
    if (signal?.aborted && cause instanceof PicPatchSdkError && cause.kind === 'cancelled') throw cause;
    checkSignal(signal);
    if (deadline.signal.aborted) throw new PicPatchSdkError('TIMEOUT', message, { cause, ...(cause instanceof PicPatchSdkError ? { effect: cause.effect, ...(cause.subject ? { subject: cause.subject } : {}), details: cause.details } : {}) });
    throw cause;
  } finally { clearTimeout(timer); }
}
