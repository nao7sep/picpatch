import { randomUUID } from 'node:crypto';
import { PicPatchCancelledError, PicPatchRuntimeError, PicPatchUsageError } from './errors.ts';

export interface WorkerDiagnostic {
  phase: 'loading' | 'editing' | 'saving' | 'worker';
  causes: { kind: 'BackendUnavailable' | 'ModuleNotFoundError' | 'FileNotFoundError' | 'PermissionError' | 'MemoryError' | 'ValueError' | 'OSError' | 'RuntimeError' | 'Exception' | 'ProcessExit'; errno?: number }[];
  reason?: 'missing-package' | 'unsupported-version' | 'missing-directory';
  exitCode?: number;
  signal?: string;
}
export interface DiagnosticEvent {
  type: 'diagnostic';
  operationId: string;
  verb: string;
  time: string;
  level: 'info' | 'error';
  stage: 'started' | 'progress' | 'succeeded' | 'failed' | 'cancelled';
  message: string;
  progress?: { stage: string; completed?: number; total?: number };
  error?: { code: string; causes: { kind: string; code?: string }[]; worker?: WorkerDiagnostic };
}
export interface DiagnosticOptions { onDiagnostic?: (event: DiagnosticEvent) => void }
const scope = Symbol('diagnostic scope');
type Scoped = DiagnosticOptions & { [scope]?: { id: string; verb: string } };

/** Caller-owned sinks are best effort and cannot change the primary operation outcome. */
function deliver(options: Scoped, event: Omit<DiagnosticEvent, 'type' | 'operationId' | 'verb' | 'time'>): void {
  const context = options[scope];
  if (!context || !options.onDiagnostic) return;
  try {
    const returned: unknown = options.onDiagnostic({ type: 'diagnostic', operationId: context.id, verb: context.verb, time: new Date().toISOString(), ...event });
    // Do not await caller-owned asynchronous logging or leave rejected sinks unhandled.
    if (returned instanceof Promise) void returned.catch(() => {});
  } catch { /* Diagnostic delivery must not replace a saved result or its original failure. */ }
}
export function diagnosticProgress(options: DiagnosticOptions, event: { stage: string; completed?: number; total?: number }): void {
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
export async function withDiagnostics<O extends DiagnosticOptions, T>(verb: string, options: O, action: (options: O) => Promise<T>): Promise<T> {
  if (!options || typeof options !== 'object' || Array.isArray(options)) return action(options);
  if (options.onDiagnostic !== undefined && typeof options.onDiagnostic !== 'function') throw new PicPatchUsageError('INVALID_REQUEST', 'Invalid diagnostic callback.');
  const operation = { ...options, [scope]: { id: randomUUID(), verb } };
  deliver(operation, { level: 'info', stage: 'started', message: 'Operation started.' });
  try {
    const result = await action(operation);
    deliver(operation, { level: 'info', stage: 'succeeded', message: 'Operation completed.' });
    return result;
  } catch (error) {
    const cancelled = error instanceof PicPatchCancelledError;
    const known = cancelled || error instanceof PicPatchRuntimeError || error instanceof PicPatchUsageError;
    deliver(operation, { level: cancelled ? 'info' : 'error', stage: cancelled ? 'cancelled' : 'failed', message: cancelled ? 'Operation cancelled.' : 'Operation failed.',
      error: { code: known ? error.code : 'UNKNOWN', causes: safeCauses(error), ...(error instanceof PicPatchRuntimeError && error.diagnostic ? { worker: structuredClone(error.diagnostic) } : {}) } });
    throw error;
  }
}
