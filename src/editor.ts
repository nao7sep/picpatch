import { ImageEditor } from './images/editor.ts';
import { isAbsolute } from 'node:path';
import { workerLaunch, workerTimeouts } from './worker/launch.ts';
import type { EditRequest, EditResult, OperationOptions } from './types.ts';
import { PicPatchCancelledError, PicPatchRuntimeError, PicPatchUsageError } from './errors.ts';
import { validateEditRequest } from './validation.ts';
import { WorkerProcess, type WorkerTimeouts } from './worker/process.ts';
import type { WorkerResponse } from './worker/protocol.ts';

export interface Editor {
  edit(request: EditRequest, options?: OperationOptions): Promise<EditResult>;
  dispose(): Promise<void>;
}
export interface EditorOptions {
  /** An existing interpreter with the worker's locked dependencies installed. */
  pythonExecutable: string;
  timeouts?: Partial<WorkerTimeouts>;
}
const defaults = workerTimeouts;

/** Creates a lazy editor. Does not install Python, packages, or models. */
export function createEditor(options: EditorOptions): Editor {
  if (!options || typeof options.pythonExecutable !== 'string' || !isAbsolute(options.pythonExecutable) || options.pythonExecutable.includes('\0')) {
    throw new PicPatchUsageError('INVALID_REQUEST', 'pythonExecutable must be an absolute interpreter path.');
  }
  if (Object.keys(options).some(key => !['pythonExecutable', 'timeouts'].includes(key)) ||
      (options.timeouts !== undefined && (typeof options.timeouts !== 'object' || options.timeouts === null || Array.isArray(options.timeouts)))) {
    throw new PicPatchUsageError('INVALID_REQUEST', 'Invalid editor options.');
  }
  const timeouts = { ...defaults, ...options.timeouts };
  for (const [key, value] of Object.entries(timeouts)) {
    if (!(key in defaults) || !Number.isSafeInteger(value) || value <= 0 || value > 1_000_000_000) {
      throw new PicPatchUsageError('INVALID_REQUEST', 'Timeouts must be positive whole milliseconds within the timer range.');
    }
  }
  const worker = new WorkerProcess(workerLaunch(options.pythonExecutable), timeouts);
  return new ImageEditor(new ProcessEditor(worker));
}

function responseError(response: Extract<WorkerResponse, { type: 'error' }>): Error {
  const { code, message } = response.error;
  if (code === 'CANCELLED') return new PicPatchCancelledError(message);
  if (code === 'INVALID_REQUEST' || code === 'BUSY') return new PicPatchUsageError(code, message);
  return new PicPatchRuntimeError(code === 'NOT_READY' ? 'PROTOCOL_ERROR' : code, message);
}

/** Internal seam shared by the public factory and model-free lifecycle tests. */
export class ProcessEditor implements Editor {
  private busy = false;
  private disposed = false;
  private disposal: Promise<void> | undefined;
  private readonly worker: WorkerProcess;
  constructor(worker: WorkerProcess) { this.worker = worker; }

  async edit(input: EditRequest, options: OperationOptions = {}): Promise<EditResult> {
    if (this.disposed) throw new PicPatchUsageError('DISPOSED', 'Editor has been disposed.');
    if (this.busy) throw new PicPatchUsageError('BUSY', 'An edit is already active on this editor.');
    const request = validateEditRequest(input);
    if (!options || typeof options !== 'object' || Object.keys(options).some(key => !['signal', 'onProgress'].includes(key)) ||
      (options.signal !== undefined && !(options.signal instanceof AbortSignal)) ||
      (options.onProgress !== undefined && typeof options.onProgress !== 'function')) {
      throw new PicPatchUsageError('INVALID_REQUEST', 'Invalid operation options.');
    }
    const { signal, onProgress } = options;
    if (signal?.aborted) throw new PicPatchCancelledError();
    this.busy = true;
    const abortStartup = () => this.worker.abortStartup();
    signal?.addEventListener('abort', abortStartup, { once: true });
    try {
      let ready: WorkerResponse;
      try { ready = await this.worker.start(); }
      finally { signal?.removeEventListener('abort', abortStartup); }
      if (this.disposed || signal?.aborted) throw new PicPatchCancelledError();
      if (ready.type === 'error') throw responseError(ready);
      if (ready.type !== 'ready') throw new PicPatchRuntimeError('PROTOCOL_ERROR', 'Worker did not complete its handshake.');
      const capabilities = ready.models.find(model => model.model === request.model);
      if (!capabilities) throw new PicPatchUsageError('UNSUPPORTED_CAPABILITY', 'The worker does not advertise the requested model.');
      validateEditRequest(request, capabilities);
      const response = await this.worker.edit(request, onProgress, signal);
      if (response.type === 'error') throw responseError(response);
      if (response.type !== 'result') throw new PicPatchRuntimeError('PROTOCOL_ERROR', 'Worker returned no edit result.');
      return response.result;
    } finally { this.busy = false; }
  }

  dispose(): Promise<void> {
    this.disposed = true;
    this.disposal ??= this.worker.dispose();
    return this.disposal;
  }
}
