import { validateDefaults, type EditDefaults, type GenerateInput, type EditInput } from './defaults.ts';
import { defaultPythonExecutable, workerLaunch } from './backends/mflux/launch.ts';
import { validateLocalEditingModel } from './models/verification.ts';
import type { LocalEditingModel } from './contracts.generated.ts';
import { ImageEditor } from './execution/session.ts';
import { isAbsolute } from 'node:path';
import type { EditResult, OperationOptions } from './types.ts';
import { PicPatchUsageError } from './errors.ts';
import { WorkerProcess, workerTimeouts, type WorkerTimeouts } from './worker/process.ts';
import { ProcessEditor } from './execution/worker-backend.ts';

export interface Editor {
  generate(request: GenerateInput, options?: OperationOptions): Promise<EditResult>;
  edit(request: EditInput, options?: OperationOptions): Promise<EditResult>;
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
