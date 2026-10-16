import { validateDefaults, type EditDefaults, type EditInput } from './defaults.ts';
import { defaultPythonExecutable } from './worker/launch.ts';
import { emitProgress, validateOperation } from './operations.ts';
import { validateLocalEditingModel } from './models/verification.ts';
import type { LocalEditingModel } from './contracts.generated.ts';
import { ImageEditor } from './images/editor.ts';
import { isAbsolute } from 'node:path';
import { workerLaunch, workerTimeouts } from './worker/launch.ts';
import type { EditRequest, EditResult, ModelCapabilities, OperationOptions } from './types.ts';
import { PicPatchCancelledError, PicPatchRuntimeError, PicPatchUsageError } from './errors.ts';
import { validateEditRequest } from './validation.ts';
import { WorkerProcess, type WorkerTimeouts } from './worker/process.ts';
import type { WorkerResponse } from './worker/protocol.ts';

export interface Editor {
  edit(request: EditInput, options?: OperationOptions): Promise<EditResult>;
  dispose(): Promise<void>;
}
export interface EditBackend {
  /** Check advertised metadata before image I/O; does not load model weights. */
  validate(request: EditRequest, options?: OperationOptions): Promise<ModelCapabilities>;
  edit(request: EditRequest, options?: OperationOptions): Promise<EditResult>;
  dispose(): Promise<void>;
}
export interface EditorOptions {
  /** An existing interpreter with the worker's locked dependencies installed. */
  pythonExecutable?: string;
  defaults?: EditDefaults;
  timeouts?: Partial<WorkerTimeouts>;
  /** Experimental offline adapter; the manifest pins caller-supplied files. */
  model?: LocalEditingModel;
}
const defaults = workerTimeouts;

/** Creates a lazy editor. Does not install Python, packages, or models. */
export function createEditor(options: EditorOptions = {}): Editor {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new PicPatchUsageError('INVALID_REQUEST', 'Invalid editor options.');
  const pythonExecutable = options.pythonExecutable === undefined ? defaultPythonExecutable() : options.pythonExecutable;
  if (typeof pythonExecutable !== 'string' || !isAbsolute(pythonExecutable) || pythonExecutable.includes('\0')) {
    throw new PicPatchUsageError('INVALID_REQUEST', 'pythonExecutable must be an absolute interpreter path.');
  }
  if (Object.keys(options).some(key => !['pythonExecutable', 'timeouts', 'model', 'defaults'].includes(key)) ||
      (options.timeouts !== undefined && (typeof options.timeouts !== 'object' || options.timeouts === null || Array.isArray(options.timeouts)))) {
    throw new PicPatchUsageError('INVALID_REQUEST', 'Invalid editor options.');
  }
  const timeouts = { ...defaults, ...options.timeouts };
  for (const [key, value] of Object.entries(timeouts)) {
    if (!(key in defaults) || !Number.isSafeInteger(value) || value <= 0 || value > 1_000_000_000) {
      throw new PicPatchUsageError('INVALID_REQUEST', 'Timeouts must be positive whole milliseconds within the timer range.');
    }
  }
  let model: LocalEditingModel | undefined;
  if (options.model !== undefined) {
    model = validateLocalEditingModel(options.model);
  }
  const worker = new WorkerProcess({ ...workerLaunch(pythonExecutable), ...(model ? { model } : {}) }, timeouts);
  return new ImageEditor(new ProcessEditor(worker, model), validateDefaults(options.defaults), model?.manifest.model);
}

function responseError(response: Extract<WorkerResponse, { type: 'error' }>): Error {
  const { code, message } = response.error;
  if (code === 'CANCELLED') return new PicPatchCancelledError(message);
  if (code === 'INVALID_REQUEST' || code === 'BUSY') return new PicPatchUsageError(code, message);
  const error = new PicPatchRuntimeError(code === 'NOT_READY' ? 'PROTOCOL_ERROR' : code, message);
  if (response.error.diagnostic) error.diagnostic = response.error.diagnostic;
  return error;
}

/** Internal seam shared by the public factory and model-free lifecycle tests. */
export class ProcessEditor implements EditBackend {
  private busy = false;
  private disposed = false;
  private disposal: Promise<void> | undefined;
  private readonly worker: WorkerProcess;
  private readonly model: LocalEditingModel | undefined;
  constructor(worker: WorkerProcess, model?: LocalEditingModel) { this.worker = worker; this.model = model; }

  async edit(input: EditRequest, options: OperationOptions = {}): Promise<EditResult> {
    if (this.disposed) throw new PicPatchUsageError('DISPOSED', 'Editor has been disposed.');
    if (this.busy) throw new PicPatchUsageError('BUSY', 'An edit is already active on this editor.');
    const request = validateEditRequest(input);
    validateOperation(options);
    const { signal, ...progressOptions } = options;
    if (signal?.aborted) throw new PicPatchCancelledError();
    this.busy = true;
    try {
      await this.validate(request, options);
      const response = await this.worker.edit(request, event => emitProgress(progressOptions, event), signal);
      if (response.type === 'error') throw responseError(response);
      if (response.type !== 'result') throw new PicPatchRuntimeError('PROTOCOL_ERROR', 'Worker returned no edit result.');
      return response.result;
    } finally { this.busy = false; }
  }

  async validate(request: EditRequest, options: OperationOptions = {}): Promise<ModelCapabilities> {
    if (this.disposed) throw new PicPatchUsageError('DISPOSED', 'Editor has been disposed.');
    const { signal } = options;
    if (signal?.aborted) throw new PicPatchCancelledError();
    if (this.model && request.model !== this.model.manifest.model) throw new PicPatchUsageError('UNSUPPORTED_CAPABILITY', 'The editor is configured for a different model.');
    const abortStartup = () => this.worker.abortStartup();
    signal?.addEventListener('abort', abortStartup, { once: true });
    let ready: WorkerResponse;
    try { ready = await this.worker.start(); }
    finally { signal?.removeEventListener('abort', abortStartup); }
    if (this.disposed || signal?.aborted) throw new PicPatchCancelledError();
    if (ready.type === 'error') throw responseError(ready);
    if (ready.type !== 'ready') throw new PicPatchRuntimeError('PROTOCOL_ERROR', 'Worker did not complete its handshake.');
    const capabilities = ready.models.find(model => model.model === request.model);
    if (!capabilities) throw new PicPatchUsageError('UNSUPPORTED_CAPABILITY', 'The worker does not advertise the requested model.');
    validateEditRequest(request, capabilities);
    return capabilities;
  }

  dispose(): Promise<void> {
    this.disposed = true;
    this.disposal ??= this.worker.dispose();
    return this.disposal;
  }
}
