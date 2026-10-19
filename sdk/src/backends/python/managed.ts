import { modelCapabilities, modelRuntime } from '../../models/variants.ts';
import { validateEditRequest, validateGenerateRequest } from '../../validation.ts';
import { dirname } from 'node:path';
import type { EditBackend } from '../../execution/backend.ts';
import { ProcessEditor } from '../../execution/worker-backend.ts';
import { WorkerProcess, type WorkerTimeouts } from '../../worker/process.ts';
import { resolveEngine } from '../../runtime/engine/engine.ts';
import type { LocalModel } from '../../contracts.generated.ts';
import type { ImageRequest, GenerateRequest, EditRequest, OperationOptions } from '../../types.ts';
import { PicPatchSdkError } from '../../errors.ts';
import { checkSignal } from '../../operations.ts';
import { workerLaunch } from './launch.ts';

/** Lazy selection binds this editor to one immutable environment. Installation is always explicit. */
export class ManagedBackend implements EditBackend {
  private backend: ProcessEditor | undefined;
  private opening: Promise<ProcessEditor> | undefined;
  private disposed = false;
  private readonly root: string;
  private readonly model: LocalModel | undefined;
  private readonly timeouts: WorkerTimeouts;
  constructor(root: string, model: LocalModel | undefined, timeouts: WorkerTimeouts) { this.root = root; this.model = model; this.timeouts = timeouts; }
  describe(request: ImageRequest) {
    if (!this.model) throw new PicPatchSdkError('UNSUPPORTED_CAPABILITY', 'Planning requires a prepared model.');
    const capabilities = modelCapabilities(this.model.variant, this.model.manifest.model);
    if ('prompt' in request) validateGenerateRequest(request, capabilities); else validateEditRequest(request, capabilities);
    return capabilities;
  }
  private open(signal?: AbortSignal): Promise<ProcessEditor> {
    if (this.disposed) return Promise.reject(new PicPatchSdkError('DISPOSED', 'Image client has been disposed.'));
    this.opening ??= (async () => {
      const engine = await resolveEngine(this.root, signal, modelRuntime(this.model?.variant));
      checkSignal(signal);
      if (this.disposed) throw new PicPatchSdkError('DISPOSED', 'Image client has been disposed.');
      const installation = dirname(dirname(dirname(engine.pythonExecutable)));
      this.backend = new ProcessEditor(new WorkerProcess({ ...workerLaunch(engine.pythonExecutable, installation, modelRuntime(this.model?.variant)), ...(this.model ? { model: this.model } : {}) }, this.timeouts), this.model);
      return this.backend;
    })().catch(error => { this.opening = undefined; throw error; });
    return this.opening;
  }
  async validate(request: ImageRequest, options: OperationOptions = {}) {
    // Only a new explicit operation reaches this point. Never replay the failed operation.
    if (this.backend?.restartable) {
      await this.backend.dispose();
      this.backend = undefined;
      this.opening = undefined;
    }
    return (await this.open(options.signal)).validate(request, options);
  }
  async generate(request: GenerateRequest, options: OperationOptions = {}) { return (await this.open(options.signal)).generate(request, options); }
  async edit(request: EditRequest, options: OperationOptions = {}) { return (await this.open(options.signal)).edit(request, options); }
  async dispose(): Promise<void> {
    this.disposed = true;
    try { await this.opening; } catch { /* Admission failure started no worker. */ }
    await this.backend?.dispose();
  }
}
