import type { EditBackend } from './backend.ts';
import type { LocalEditingModel } from '../contracts.generated.ts';
import type { ImageRequest, GenerateRequest, EditRequest, EditResult, ModelCapabilities, ProgressEvent, OperationOptions } from '../types.ts';
import { PicPatchCancelledError, PicPatchRuntimeError, PicPatchUsageError } from '../errors.ts';
import { validateEditRequest, validateGenerateRequest } from '../validation.ts';
import { emitProgress, validateOperation } from '../operations.ts';
import { WorkerProcess } from '../worker/process.ts';
import type { WorkerResponse } from '../worker/protocol.ts';

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
    return this.execute(validateEditRequest(input), options);
  }

  async generate(input: GenerateRequest, options: OperationOptions = {}): Promise<EditResult> {
    return this.execute(validateGenerateRequest(input), options);
  }

  private async execute(request: ImageRequest, options: OperationOptions): Promise<EditResult> {
    if (this.disposed) throw new PicPatchUsageError('DISPOSED', 'Editor has been disposed.');
    if (this.busy) throw new PicPatchUsageError('BUSY', 'An operation is already active on this editor.');
    validateOperation(options);
    const { signal, ...progressOptions } = options;
    if (signal?.aborted) throw new PicPatchCancelledError();
    this.busy = true;
    try {
      await this.validate(request, options);
      const onProgress = (event: ProgressEvent) => emitProgress(progressOptions, event);
      const response = 'prompt' in request ? await this.worker.generate(request, onProgress, signal) : await this.worker.edit(request, onProgress, signal);
      if (response.type === 'error') throw responseError(response);
      if (response.type !== 'result') throw new PicPatchRuntimeError('PROTOCOL_ERROR', 'Worker returned no image result.');
      return response.result;
    } finally { this.busy = false; }
  }

  async validate(request: ImageRequest, options: OperationOptions = {}): Promise<ModelCapabilities> {
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
    if ('prompt' in request) validateGenerateRequest(request, capabilities);
    else validateEditRequest(request, capabilities);
    return capabilities;
  }

  dispose(): Promise<void> {
    this.disposed = true;
    this.disposal ??= this.worker.dispose();
    return this.disposal;
  }
}
