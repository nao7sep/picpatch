import { storageScope, storageStalled } from '../storage.ts';
import { planImage, type ImagePlan, type GenerateImagePlan, type EditImagePlan } from '../images/planning.ts';
import { resolveGenerateRequest, resolveEditRequest, type GenerateInput, type EditDefaults, type EditInput } from '../defaults.ts';
import { emitProgress, validateOperation, timeBudget, withDeadline } from '../operations.ts';
import { diagnosticLifetime, withDiagnostics, type RuntimeConfiguration } from '../diagnostics.ts';
import type { Editor } from '../client.ts';
import type { EditBackend } from './backend.ts';
import type { ImageRequest, ImageOutcome, OperationOptions, OperationRefusal } from '../types.ts';
import { PicPatchSdkError, sdkError } from '../errors.ts';
import { checkCancellation } from '../images/validation.ts';
import { ImageWorkspace } from '../images/output.ts';

/** Coordinates files with the worker's actual settlement, including disposal. */
export class ImageEditor implements Editor {
  private readonly diagnostics;
  private readonly backend: EditBackend;
  private readonly lifetime = new AbortController();
  private tail: Promise<void> = Promise.resolve();
  private disposal: Promise<void> | undefined;
  private readonly plans = new WeakSet<ImagePlan>();
  private readonly defaults: EditDefaults;
  private readonly model: string | undefined;
  constructor(backend: EditBackend, defaults: EditDefaults = {}, model?: string, configuration: RuntimeConfiguration = {}) { this.diagnostics = diagnosticLifetime(configuration); this.backend = backend; this.defaults = defaults; this.model = model; }

  edit(input: EditInput | EditImagePlan, options: OperationOptions = {}): Promise<ImageOutcome> {
    const plan = this.acceptPlan(input, 'edit');
    if (plan instanceof PicPatchSdkError) return Promise.reject(plan);
    return this.submit(() => plan ? structuredClone(plan.request) : resolveEditRequest(input as EditInput, this.defaults, this.model), options, plan);
  }

  generate(input: GenerateInput | GenerateImagePlan, options: OperationOptions = {}): Promise<ImageOutcome> {
    const plan = this.acceptPlan(input, 'generate');
    if (plan instanceof PicPatchSdkError) return Promise.reject(plan);
    return this.submit(() => plan ? structuredClone(plan.request) : resolveGenerateRequest(input as GenerateInput, this.defaults, this.model), options, plan);
  }

  plan(input: GenerateInput, options?: OperationOptions): Promise<GenerateImagePlan | OperationRefusal>;
  plan(input: EditInput, options?: OperationOptions): Promise<EditImagePlan | OperationRefusal>;
  plan(input: GenerateInput | EditInput, options?: OperationOptions): Promise<ImagePlan | OperationRefusal>;
  plan(input: GenerateInput | EditInput, options: OperationOptions = {}): Promise<ImagePlan | OperationRefusal> {
    if (this.lifetime.signal.aborted) return Promise.reject(new PicPatchSdkError('DISPOSED', 'Editor has been disposed.'));
    let request: ImageRequest;
    try {
      validateOperation(options);
      request = structuredClone(input && typeof input === 'object' && 'prompt' in input
        ? resolveGenerateRequest(input, this.defaults, this.model) : resolveEditRequest(input as EditInput, this.defaults, this.model));
    } catch (error) { const refused = refusal(error); return refused ? Promise.resolve(refused) : Promise.reject(error); }
    const captured = { ...options, signal: AbortSignal.any([this.lifetime.signal, ...(options.signal ? [options.signal] : [])]) };
    const pending = Promise.resolve().then(() => withDiagnostics('plan', captured, operation => withDeadline(operation.signal, timeBudget(operation.timeoutMs, 60_000), 'Image planning timed out.', async signal => {
      try {
        if (!this.backend.describe) throw new PicPatchSdkError('UNSUPPORTED_CAPABILITY', 'This backend cannot plan without a registered model.');
        const result = await planImage(request, this.backend.describe(request), signal);
        return result;
      } catch (error) { const refused = refusal(error); if (refused) return refused; throw error; }
    }), this.diagnostics));
    const accepted = pending.then(result => { if (result.status === 'planned') { Object.freeze(result); this.plans.add(result); } return result; });
    this.tail = Promise.allSettled([this.tail, accepted]).then(() => {});
    return accepted;
  }

  private acceptPlan(value: unknown, operation: ImagePlan['operation']): ImagePlan | PicPatchSdkError | undefined {
    if (!value || typeof value !== 'object' || !('status' in value)) return undefined;
    if (!this.plans.has(value as ImagePlan) || (value as ImagePlan).operation !== operation) return new PicPatchSdkError('INVALID_REQUEST', 'Use an unchanged plan from this editor with its matching verb.');
    return value as ImagePlan;
  }

  private submit(resolve: () => ImageRequest, options: OperationOptions, plan?: ImagePlan): Promise<ImageOutcome> {
    if (this.lifetime.signal.aborted) return Promise.reject(new PicPatchSdkError('DISPOSED', 'Editor has been disposed.'));
    let request: ImageRequest;
    let budget: number;
    try {
      request = structuredClone(resolve());
      validateOperation(options);
      budget = timeBudget(options.timeoutMs, 1_800_000);
    } catch (error) { const refused = refusal(error); return refused ? Promise.resolve(refused) : Promise.reject(error); }
    const callerSignal = options.signal;
    const deadline = new AbortController();
    const signal = AbortSignal.any([this.lifetime.signal, deadline.signal, ...(options.signal ? [options.signal] : [])]);
    const captured = { ...options, signal, ...(options.caller ? { caller: structuredClone(options.caller) } : {}) };
    const timer = setTimeout(() => deadline.abort(), budget);
    const previous = this.tail;
    const operation = Promise.resolve().then(() => withDiagnostics('prompt' in request ? 'generate' : 'edit', captured, async scoped => {
      try {
        await waitForTurn(previous, signal);
        checkCancellation(signal);
        return await storageScope(signal, () => this.run(request, signal, scoped, plan));
      } catch (error) {
        if (deadline.signal.aborted && (error instanceof PicPatchSdkError && error.kind === 'cancelled') && !this.lifetime.signal.aborted && !callerSignal?.aborted) {
          throw new PicPatchSdkError('TIMEOUT', 'Image operation timed out.', { cause: error, effect: error.effect, details: error.details, ...(error.subject ? { subject: error.subject } : {}) });
        }
        throw error;
      }
    }, this.diagnostics)).finally(() => clearTimeout(timer));
    // A cancelled waiter settles promptly, but cannot let later calls overtake its predecessor.
    this.tail = Promise.allSettled([previous, operation]).then(() => {});
    return operation;
  }

  private async run(request: ImageRequest, signal: AbortSignal, options: OperationOptions, plan?: ImagePlan): Promise<ImageOutcome> {
    let workspace: ImageWorkspace | undefined;
    let result: import('../types.ts').ImageResult | undefined;
    let failure: unknown;
    try {
      checkCancellation(signal);
      const capabilities = plan?.capabilities ?? await this.backend.validate(request, options);
      checkCancellation(signal);
      emitProgress(options, { type: 'progress', verb: 'prompt' in request ? 'generate' : 'edit', stage: 'preparing', message: 'Preparing image operation.' });
      workspace = await ImageWorkspace.create(request, signal, plan);
      await workspace.prepare(signal, capabilities.inputGeometry, capabilities.maskMode, capabilities.defaultOutputSize, plan);
      if (plan) await this.backend.validate(workspace.workerRequest, options);
      const response = 'prompt' in workspace.workerRequest
        ? await this.backend.generate(workspace.workerRequest, options)
        : await this.backend.edit(workspace.workerRequest, options);
      result = await workspace.publish(response, signal, options.caller);
    } catch (error) {
      failure = error;
      if (error instanceof PicPatchSdkError && error.code === 'TERMINATION_FAILED' && workspace) {
        workspace.preserve();
        error.details.recoveryDirectory = workspace.directory;
        error.effect = 'unknown';
      }
    }
    if (storageStalled() && workspace) {
      workspace.preserve();
      if (result) result.cleanupWarning = { directory: workspace.directory, message: 'Image was saved; private files were retained because storage work may still settle.' };
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
    const refused = refusal(error, request.outputPath);
    if (refused) return refused;
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

function refusal(value: unknown, subject = ''): OperationRefusal | undefined {
  if (!(value instanceof PicPatchSdkError) || !['OUTPUT_CONFLICT', 'INPUTS_CHANGED', 'DESTINATION_CHANGED'].includes(value.code)) return undefined;
  return { status: 'refused', code: value.code as OperationRefusal['code'], message: value.message, effect: value.effect, subject: value.subject ?? subject, details: value.details };
}
