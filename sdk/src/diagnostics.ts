import { withoutStorageScope } from './storage.ts';
import packageInfo from '../package.json' with { type: 'json' };
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
  name: 'sdk.startup' | 'operation.started' | 'operation.succeeded' | 'operation.refused' | 'operation.failed' | 'operation.cancelled' | 'operation.stage' | 'hook.failed' | 'operation.progress';
  startup?: { sdk: string; version: string; runtime: { node: string; platform: string; architecture: string }; configuration: RuntimeConfiguration };
  refusal?: { code: string; effect: import('./errors.ts').ErrorEffect };
  progress?: { completed: number; total: number };
  operationId: string;
  verb: string;
  time: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  stage: string;
  message: string;
  error?: { code: string; kind: import('./errors.ts').ErrorKind; effect: import('./errors.ts').ErrorEffect; causes: { kind: string; code?: string }[]; worker?: WorkerDiagnostic };
}
export interface EventOptions {
  /** Include diagnostic progress counts in onEvent. Off by default; no environment is read. */
  debug?: boolean;
  onEvent?: (event: SdkEvent) => void;
}
export interface RuntimeConfiguration { backend?: 'mflux' | 'dreamo' | 'stable-diffusion-cpp'; timeouts?: import('./worker/process.ts').WorkerTimeouts }
/** Stateless verbs share the module lifetime; editors supply their own lifetime. */
export function diagnosticLifetime(configuration: RuntimeConfiguration = {}) { return { started: false, configuration }; }
const moduleLifetime = diagnosticLifetime();
const scope = Symbol('diagnostic scope');
type Scoped = EventOptions & { [scope]?: { id: string; verb: string; progressFailed?: boolean; lastStage?: string; lastProgress?: number | undefined } };

/** Caller-owned sinks are best effort and cannot change the primary operation outcome. */
function deliver(options: Scoped, event: Omit<SdkEvent, 'type' | 'operationId' | 'verb' | 'time'>): void {
  const context = options[scope];
  if (!context || (event.level === 'debug' && !options.debug)) return;
  const record: SdkEvent = { type: 'event', operationId: context.id, verb: context.verb, time: new Date().toISOString(), ...event };
  if (!options.onEvent) return;
  try {
    const returned: unknown = options.onEvent(record);
    // Do not await caller-owned asynchronous logging or leave rejected sinks unhandled.
    void Promise.resolve(returned).catch(() => { /* No fallback to the hook that failed. */ });
  } catch { /* Diagnostic delivery must not replace a saved result or its original failure. */ }
}
export function operationStage(options: EventOptions, stage: 'checking' | 'installing' | 'publishing', message: string): void {
  deliver(options, { name: 'operation.stage', level: 'info', stage, message });
}
/** Reports progress-sink failure through the separate event sink, at most once per call. */
export function progressHookFailed(options: EventOptions): void {
  const context = (options as Scoped)[scope];
  if (!context || context.progressFailed) return;
  context.progressFailed = true;
  deliver(options, { name: 'hook.failed', level: 'warn', stage: 'hook-failed', message: 'The progress callback failed; the operation continues.' });
}
/** Stages are events; only counted work is progress, delivered at most ten times a second. */
export function diagnosticProgress(options: EventOptions, event: { stage: string; completed?: number; total?: number }): boolean {
  const context = (options as Scoped)[scope];
  if (context?.lastStage !== event.stage) {
    deliver(options, { name: 'operation.stage', level: 'info', stage: event.stage, message: `Operation stage: ${event.stage}.` });
    if (context) { context.lastStage = event.stage; context.lastProgress = undefined; }
  }
  if (event.completed === undefined || event.total === undefined) return false;
  const now = performance.now();
  if (context && context.lastProgress !== undefined && now - context.lastProgress < 100 && event.completed !== event.total) return false;
  if (context) context.lastProgress = now;
  deliver(options, { name: 'operation.progress', level: 'debug', stage: event.stage, message: 'Operation progress.', progress: { completed: event.completed, total: event.total } });
  return true;
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
export async function withDiagnostics<O extends EventOptions, T>(verb: string, options: O, action: (options: O) => Promise<T>, lifetime = moduleLifetime): Promise<T> {
  if (!options || typeof options !== 'object' || Array.isArray(options)) return action(options);
  if ((options as Scoped)[scope]) return action(options);
  if (options.onEvent !== undefined && typeof options.onEvent !== 'function') throw new PicPatchSdkError('INVALID_REQUEST', 'Invalid diagnostic callback.');
  if (options.debug !== undefined && typeof options.debug !== 'boolean') throw new PicPatchSdkError('INVALID_REQUEST', 'Invalid debug option.');
  const operation = { ...options, [scope]: { id: randomUUID(), verb } };
  if (!lifetime.started) {
    lifetime.started = true;
    deliver(operation, { name: 'sdk.startup', level: 'info', stage: 'startup', message: 'PicPatchSdk started.', startup: {
      sdk: packageInfo.name, version: packageInfo.version,
      runtime: { node: process.versions.node, platform: process.platform, architecture: process.arch },
      configuration: structuredClone(lifetime.configuration),
    } });
  }
  deliver(operation, { name: 'operation.started', level: 'info', stage: 'started', message: 'Operation started.' });
  try {
    const result = await withoutStorageScope(() => action(operation));
    const refused = result !== null && typeof result === 'object' && 'status' in result && result.status === 'refused';
    const refusal: SdkEvent['refusal'] = refused && 'code' in result && typeof result.code === 'string' && 'effect' in result && (result.effect === 'none' || result.effect === 'unknown') ? { code: result.code, effect: result.effect } : undefined;
    deliver(operation, { ...(refusal ? { refusal } : {}), name: refused ? 'operation.refused' : 'operation.succeeded', level: 'info', stage: refused ? 'refused' : 'succeeded', message: refused ? 'Operation refused.' : 'Operation completed.' });
    return result;
  } catch (cause) {
    const error = sdkError(cause);
    const cancelled = error.kind === 'cancelled';
    deliver(operation, { name: cancelled ? 'operation.cancelled' : 'operation.failed', level: cancelled ? 'info' : 'error', stage: cancelled ? 'cancelled' : 'failed', message: cancelled ? 'Operation cancelled.' : 'Operation failed.',
      error: { code: error.code, kind: error.kind, effect: error.effect, causes: safeCauses(error), ...(error.details.diagnostic ? { worker: structuredClone(error.details.diagnostic) } : {}) } });
    throw error;
  }
}
