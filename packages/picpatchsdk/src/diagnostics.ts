import { randomUUID } from 'node:crypto';
import { PicPatchSdkError, sdkError } from './errors.ts';

export interface WorkerDiagnostic {
  phase: 'loading' | 'generating' | 'editing' | 'saving' | 'worker';
  causes: { kind: 'BackendUnavailable' | 'ModuleNotFoundError' | 'FileNotFoundError' | 'PermissionError' | 'MemoryError' | 'ValueError' | 'OSError' | 'RuntimeError' | 'Exception' | 'ProcessExit'; errno?: number }[];
  reason?: 'missing-package' | 'unsupported-version' | 'missing-directory';
  exitCode?: number;
  signal?: string;
}
export interface SdkEvent {
  type: 'event';
  operationId: string;
  verb: string;
  time: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  stage: 'started' | 'progress' | 'succeeded' | 'failed' | 'cancelled' | 'hook-failed' | 'refused' | 'checking' | 'installing' | 'publishing';
  message: string;
  progress?: { stage: string; completed?: number; total?: number };
  error?: { code: string; kind: import('./errors.ts').ErrorKind; effect: import('./errors.ts').ErrorEffect; causes: { kind: string; code?: string }[]; worker?: WorkerDiagnostic };
}
export interface EventOptions { onEvent?: (event: SdkEvent) => void }
const scope = Symbol('diagnostic scope');
type Scoped = EventOptions & { [scope]?: { id: string; verb: string; progressFailed?: boolean } };

/** Caller-owned sinks are best effort and cannot change the primary operation outcome. */
function deliver(options: Scoped, event: Omit<SdkEvent, 'type' | 'operationId' | 'verb' | 'time'>): void {
  const context = options[scope];
  if (!context || !options.onEvent) return;
  try {
    const returned: unknown = options.onEvent({ type: 'event', operationId: context.id, verb: context.verb, time: new Date().toISOString(), ...event });
    // Do not await caller-owned asynchronous logging or leave rejected sinks unhandled.
    void Promise.resolve(returned).catch(() => { /* No fallback to the hook that failed. */ });
  } catch { /* Diagnostic delivery must not replace a saved result or its original failure. */ }
}
export function operationStage(options: EventOptions, stage: 'checking' | 'installing' | 'publishing', message: string): void {
  deliver(options, { level: 'info', stage, message });
}
/** Reports progress-sink failure through the separate event sink, at most once per call. */
export function progressHookFailed(options: EventOptions): void {
  const context = (options as Scoped)[scope];
  if (!context || context.progressFailed) return;
  context.progressFailed = true;
  deliver(options, { level: 'warn', stage: 'hook-failed', message: 'The progress callback failed; the operation continues.' });
}
export function diagnosticProgress(options: EventOptions, event: { stage: string; completed?: number; total?: number }): void {
  deliver(options, { level: 'info', stage: 'progress', message: 'Operation progress.', progress: {
    stage: event.stage, ...(event.completed !== undefined ? { completed: event.completed } : {}), ...(event.total !== undefined ? { total: event.total } : {}),
  } });
}
function safeCauses(error: unknown): { kind: string; code?: string }[] {
  const causes: { kind: string; code?: string }[] = [];
  const seen = new Set<unknown>();
  const ioCodes = new Set(['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'ENOSPC', 'EIO', 'EMFILE', 'EEXIST', 'ENOTEMPTY', 'ECONNRESET', 'ETIMEDOUT']);
  while (error instanceof Error && causes.length < 4 && !seen.has(error)) {
    seen.add(error);
    const kind = error instanceof TypeError ? 'TypeError' : error instanceof RangeError ? 'RangeError' : error instanceof SyntaxError ? 'SyntaxError' : 'Error';
    const code = (error as NodeJS.ErrnoException).code;
    causes.push({ kind, ...(code && ioCodes.has(code) ? { code } : {}) });
    error = error.cause;
  }
  return causes;
}
/** One invocation identity and exactly one terminal record; no input or exception text is serialized. */
export async function withDiagnostics<O extends EventOptions, T>(verb: string, options: O, action: (options: O) => Promise<T>): Promise<T> {
  if (!options || typeof options !== 'object' || Array.isArray(options)) return action(options);
  if (options.onEvent !== undefined && typeof options.onEvent !== 'function') throw new PicPatchSdkError('INVALID_REQUEST', 'Invalid diagnostic callback.');
  const operation = { ...options, [scope]: { id: randomUUID(), verb } };
  deliver(operation, { level: 'info', stage: 'started', message: 'Operation started.' });
  try {
    const result = await action(operation);
    const refused = result !== null && typeof result === 'object' && 'status' in result && result.status === 'refused';
    deliver(operation, { level: 'info', stage: refused ? 'refused' : 'succeeded', message: refused ? 'Operation refused.' : 'Operation completed.' });
    return result;
  } catch (cause) {
    const error = sdkError(cause);
    const cancelled = error.kind === 'cancelled';
    deliver(operation, { level: cancelled ? 'info' : 'error', stage: cancelled ? 'cancelled' : 'failed', message: cancelled ? 'Operation cancelled.' : 'Operation failed.',
      error: { code: error.code, kind: error.kind, effect: error.effect, causes: safeCauses(error), ...(error.details.diagnostic ? { worker: structuredClone(error.details.diagnostic) } : {}) } });
    throw error;
  }
}
