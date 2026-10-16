import type { Editor } from '../editor.ts';
import type { EditRequest, EditResult, OperationOptions } from '../types.ts';
import { PicPatchCancelledError, PicPatchRuntimeError, PicPatchUsageError } from '../errors.ts';
import { validateEditRequest } from '../validation.ts';
import { checkCancellation } from './validation.ts';
import { ImageWorkspace } from './output.ts';

/** Coordinates files with the worker's actual settlement, including disposal. */
export class ImageEditor implements Editor {
  private readonly backend: Editor;
  private readonly lifetime = new AbortController();
  private active: Promise<EditResult> | undefined;
  private disposal: Promise<void> | undefined;
  constructor(backend: Editor) { this.backend = backend; }

  edit(input: EditRequest, options: OperationOptions = {}): Promise<EditResult> {
    if (this.lifetime.signal.aborted) return Promise.reject(new PicPatchUsageError('DISPOSED', 'Editor has been disposed.'));
    if (this.active) return Promise.reject(new PicPatchUsageError('BUSY', 'An edit is already active on this editor.'));
    let request: EditRequest;
    try {
      request = validateEditRequest(input);
      if (!options || typeof options !== 'object' || Object.keys(options).some(key => !['signal', 'onProgress'].includes(key)) ||
          (options.signal !== undefined && !(options.signal instanceof AbortSignal)) ||
          (options.onProgress !== undefined && typeof options.onProgress !== 'function')) throw new PicPatchUsageError('INVALID_REQUEST', 'Invalid operation options.');
    } catch (error) { return Promise.reject(error); }
    const signal = AbortSignal.any([this.lifetime.signal, ...(options.signal ? [options.signal] : [])]);
    const onProgress = options.onProgress;
    this.active = Promise.resolve().then(() => this.run(request, signal, onProgress)).finally(() => { this.active = undefined; });
    return this.active;
  }

  private async run(request: EditRequest, signal: AbortSignal, onProgress: OperationOptions['onProgress']): Promise<EditResult> {
    let workspace: ImageWorkspace | undefined;
    let result: EditResult | undefined;
    let failure: unknown;
    try {
      checkCancellation(signal);
      try { onProgress?.({ type: 'progress', verb: 'edit', stage: 'preparing', message: 'Validating and preparing input images.' }); }
      catch (cause) { throw new PicPatchRuntimeError('CALLBACK_FAILED', 'Progress callback failed.', { cause }); }
      workspace = await ImageWorkspace.create(request, signal);
      await workspace.prepare(signal);
      const response = await this.backend.edit(workspace.workerRequest, { signal, ...(onProgress ? { onProgress } : {}) });
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
