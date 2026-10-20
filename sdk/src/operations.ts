import { storageScope, storageCancellation } from './storage.ts';
import type { CallOptions } from './types.ts';
import { diagnosticProgress, progressHookFailed } from './diagnostics.ts';
import { isAbsolute } from 'node:path';
import { PicPatchSdkError } from './errors.ts';

export function absolutePath(path: unknown): asserts path is string {
  if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')) throw new PicPatchSdkError('INVALID_REQUEST', 'Supply an absolute filesystem path.');
}
export function checkSignal(signal?: AbortSignal): void {
  if (signal?.aborted) throw storageCancellation() ?? new PicPatchSdkError('CANCELLED', 'The operation was cancelled.');
}
/** Every verb accepts the same call options; a verb's own settings are named beside them, and any other key is refused. */
export function validateOperation(options: unknown, extraKeys: string[] = []): void {
  if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => !['signal', 'debug', 'onProgress', 'onEvent', 'timeoutMs', ...extraKeys].includes(key))) throw new PicPatchSdkError('INVALID_REQUEST', 'Invalid operation options.');
  timeBudget((options as { timeoutMs?: unknown }).timeoutMs, 1_800_000);
  const value = options as { signal?: unknown; debug?: unknown; onProgress?: unknown; onEvent?: unknown };
  if ((value.debug !== undefined && typeof value.debug !== 'boolean') || (value.signal !== undefined && !(value.signal instanceof AbortSignal)) || (value.onProgress !== undefined && typeof value.onProgress !== 'function') || (value.onEvent !== undefined && typeof value.onEvent !== 'function')) throw new PicPatchSdkError('INVALID_REQUEST', 'Invalid cancellation signal or progress callback.');
}
/**
 * A verb takes its own settings in its arguments and the one call-options set apart from them; each
 * refuses keys that belong to the other. The verb then reads both together internally.
 */
export function withSettings<S extends object, O extends CallOptions>(settings: S | undefined, keys: readonly string[], options: O): S & O {
  const value: unknown = settings ?? {};
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw new PicPatchSdkError('INVALID_REQUEST', 'Invalid arguments: check for unknown fields and call options passed as arguments.');
  validateOperation(options);
  return { ...(value as S), ...options };
}
export function emitProgress<T extends { stage: string; completed?: number; total?: number }>(options: CallOptions, event: T): void {
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
