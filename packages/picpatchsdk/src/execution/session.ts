import { resolveGenerateRequest, resolveEditRequest, type GenerateInput, type EditDefaults, type EditInput } from '../defaults.ts';
import { emitProgress, validateOperation, timeBudget } from '../operations.ts';
import { withDiagnostics } from '../diagnostics.ts';
import type { Editor } from '../client.ts';
import type { EditBackend } from './backend.ts';
import type { ImageRequest, ImageOutcome, EditResult, OperationOptions } from '../types.ts';
import { PicPatchSdkError, sdkError } from '../errors.ts';
import { checkCancellation } from '../images/validation.ts';
import { ImageWorkspace } from '../images/output.ts';

/** Coordinates files with the worker's actual settlement, including disposal. */
export class ImageEditor implements Editor {
  private readonly backend: EditBackend;
  private readonly lifetime = new AbortController();
  private tail: Promise<void> = Promise.resolve();
  private disposal: Promise<void> | undefined;
  private readonly defaults: EditDefaults;
  private readonly model: string | undefined;
  constructor(backend: EditBackend, defaults: EditDefaults = {}, model?: string) { this.backend = backend; this.defaults = defaults; this.model = model; }

  edit(input: EditInput, options: OperationOptions = {}): Promise<ImageOutcome> {
    return this.submit(() => resolveEditRequest(input, this.defaults, this.model), options);
  }

  generate(input: GenerateInput, options: OperationOptions = {}): Promise<ImageOutcome> {
    return this.submit(() => resolveGenerateRequest(input, this.defaults, this.model), options);
  }

  private submit(resolve: () => ImageRequest, options: OperationOptions): Promise<ImageOutcome> {
    if (this.lifetime.signal.aborted) return Promise.reject(new PicPatchSdkError('DISPOSED', 'Editor has been disposed.'));
    let request: ImageRequest;
    let budget: number;
    try {
      request = structuredClone(resolve());
      validateOperation(options);
      budget = timeBudget(options.timeoutMs, 1_800_000);
    } catch (error) { return Promise.reject(error); }
    const callerSignal = options.signal;
    const deadline = new AbortController();
    const signal = AbortSignal.any([this.lifetime.signal, deadline.signal, ...(options.signal ? [options.signal] : [])]);
    const captured = { ...options, signal };
    const timer = setTimeout(() => deadline.abort(), budget);
    const previous = this.tail;
    const operation = Promise.resolve().then(() => withDiagnostics('prompt' in request ? 'generate' : 'edit', captured, async scoped => {
      try {
        await waitForTurn(previous, signal);
        checkCancellation(signal);
        return await this.run(request, signal, scoped);
      } catch (error) {
        if (deadline.signal.aborted && (error instanceof PicPatchSdkError && error.kind === 'cancelled') && !this.lifetime.signal.aborted && !callerSignal?.aborted) {
          throw new PicPatchSdkError('TIMEOUT', 'Image operation timed out.', { cause: error, effect: error.effect, details: error.details, ...(error.subject ? { subject: error.subject } : {}) });
        }
        throw error;
      }
    })).finally(() => clearTimeout(timer));
    // A cancelled waiter settles promptly, but cannot let later calls overtake its predecessor.
    this.tail = Promise.allSettled([previous, operation]).then(() => {});
    return operation;
  }

  private async run(request: ImageRequest, signal: AbortSignal, options: OperationOptions): Promise<ImageOutcome> {
    let workspace: ImageWorkspace | undefined;
    let result: EditResult | undefined;
    let failure: unknown;
    try {
      checkCancellation(signal);
      const capabilities = await this.backend.validate(request, options);
      checkCancellation(signal);
      emitProgress(options, { type: 'progress', verb: 'prompt' in request ? 'generate' : 'edit', stage: 'preparing', message: 'Preparing image operation.' });
      workspace = await ImageWorkspace.create(request, signal);
      await workspace.prepare(signal, capabilities.inputGeometry, capabilities.maskMode, capabilities.defaultOutputSize);
      const response = 'prompt' in workspace.workerRequest
        ? await this.backend.generate(workspace.workerRequest, options)
        : await this.backend.edit(workspace.workerRequest, options);
      result = await workspace.publish(response, signal);
    } catch (error) {
      failure = error;
      if (error instanceof PicPatchSdkError && error.code === 'TERMINATION_FAILED' && workspace) {
        workspace.preserve();
        error.details.recoveryDirectory = workspace.directory;
        error.effect = 'unknown';
      }
    }
    try { await workspace?.cleanup(); }
    catch (cause) {
      if (result) result.cleanupWarning = { directory: workspace!.directory, message: 'Output was saved, but private temporary files could not be removed.' };
      else {
        const error = new PicPatchSdkError('CLEANUP_FAILED', 'Operation failed and private temporary files could not be removed.', { cause: new AggregateError([failure, cause]) });
        error.details.recoveryDirectory = workspace!.directory;
        error.effect = 'unknown';
        failure = error;
      }
    }
    if (result) return result;
    const error = sdkError(failure ?? new PicPatchSdkError('CANCELLED', 'The operation was cancelled.'));
    if (error.code === 'OUTPUT_CONFLICT') return { status: 'refused', code: 'OUTPUT_CONFLICT', message: error.message,
      effect: error.effect, subject: error.subject ?? request.outputPath, details: error.details };
    throw error;
  }

  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.lifetime.abort();
    this.disposal = (async () => {
      const stopped = await Promise.allSettled([this.backend.dispose(), this.tail]);
      if (stopped[0]!.status === 'rejected') throw stopped[0]!.reason;
    })();
    return this.disposal;
  }
}

function waitForTurn(previous: Promise<void>, signal: AbortSignal): Promise<void> {
  checkCancellation(signal);
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(new PicPatchSdkError('CANCELLED', 'The operation was cancelled.')); };
    signal.addEventListener('abort', abort, { once: true });
    void previous.then(() => { signal.removeEventListener('abort', abort); resolve(); });
    if (signal.aborted) abort();
  });
}
