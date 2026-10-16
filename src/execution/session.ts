import { resolveEditRequest, type EditDefaults, type EditInput } from '../defaults.ts';
import { emitProgress, validateOperation } from '../operations.ts';
import { withDiagnostics } from '../diagnostics.ts';
import type { Editor } from '../client.ts';
import type { EditBackend } from './backend.ts';
import type { EditRequest, EditResult, OperationOptions } from '../types.ts';
import { PicPatchCancelledError, PicPatchRuntimeError, PicPatchUsageError } from '../errors.ts';
import { checkCancellation } from '../images/validation.ts';
import { ImageWorkspace } from '../images/output.ts';

/** Coordinates files with the worker's actual settlement, including disposal. */
export class ImageEditor implements Editor {
  private readonly backend: EditBackend;
  private readonly lifetime = new AbortController();
  private active: Promise<EditResult> | undefined;
  private disposal: Promise<void> | undefined;
  private readonly defaults: EditDefaults;
  private readonly model: string | undefined;
  constructor(backend: EditBackend, defaults: EditDefaults = {}, model?: string) { this.backend = backend; this.defaults = defaults; this.model = model; }

  edit(input: EditInput, options: OperationOptions = {}): Promise<EditResult> {
    if (this.lifetime.signal.aborted) return Promise.reject(new PicPatchUsageError('DISPOSED', 'Editor has been disposed.'));
    if (this.active) return Promise.reject(new PicPatchUsageError('BUSY', 'An edit is already active on this editor.'));
    let request: EditRequest;
    try {
      request = resolveEditRequest(input, this.defaults, this.model);
      validateOperation(options);
    } catch (error) { return Promise.reject(error); }
    const signal = AbortSignal.any([this.lifetime.signal, ...(options.signal ? [options.signal] : [])]);
    this.active = Promise.resolve().then(() => withDiagnostics('edit', { ...options, signal }, operation => this.run(request, signal, operation))).finally(() => { this.active = undefined; });
    return this.active;
  }

  private async run(request: EditRequest, signal: AbortSignal, options: OperationOptions): Promise<EditResult> {
    let workspace: ImageWorkspace | undefined;
    let result: EditResult | undefined;
    let failure: unknown;
    try {
      checkCancellation(signal);
      const capabilities = await this.backend.validate(request, options);
      checkCancellation(signal);
      emitProgress(options, { type: 'progress', verb: 'edit', stage: 'preparing', message: 'Validating and preparing input images.' });
      workspace = await ImageWorkspace.create(request, signal);
      await workspace.prepare(signal, capabilities.inputGeometry);
      const response = await this.backend.edit(workspace.workerRequest, options);
      result = await workspace.publish(response, signal);
    } catch (error) {
      failure = error;
      if (error instanceof PicPatchRuntimeError && error.code === 'TERMINATION_FAILED' && workspace) {
        workspace.preserve();
        error.recoveryDirectory = workspace.directory;
      }
    }
    try { await workspace?.cleanup(); }
    catch (cause) {
      if (result) result.cleanupWarning = { directory: workspace!.directory, message: 'Output was saved, but private temporary files could not be removed.' };
      else {
        const error = new PicPatchRuntimeError('CLEANUP_FAILED', 'Edit failed and private temporary files could not be removed.', { cause: new AggregateError([failure, cause]) });
        error.recoveryDirectory = workspace!.directory;
        failure = error;
      }
    }
    if (result) return result;
    throw failure ?? new PicPatchCancelledError();
  }

  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.lifetime.abort();
    this.disposal = (async () => {
      const stopped = await Promise.allSettled([this.backend.dispose(), this.active]);
      if (stopped[0]!.status === 'rejected') throw stopped[0]!.reason;
    })();
    return this.disposal;
  }
}
