import { NativeBackend } from './backends/stable-diffusion-cpp/backend.ts';
import { isNativeVariant } from './backends/stable-diffusion-cpp/models.ts';
import { validateDefaults, type EditDefaults, type GenerateInput, type EditInput } from './defaults.ts';
import { ManagedBackend } from './backends/mflux/managed.ts';
import { resolveStoragePaths } from './paths.ts';
import { validateLocalEditingModel } from './models/verification.ts';
import type { LocalEditingModel } from './contracts.generated.ts';
import { ImageEditor } from './execution/session.ts';
import { isAbsolute } from 'node:path';
import type { EditResult, OperationOptions } from './types.ts';
import { PicPatchUsageError } from './errors.ts';
import { workerTimeouts, type WorkerTimeouts } from './worker/process.ts';

export interface Editor {
  generate(request: GenerateInput, options?: OperationOptions): Promise<EditResult>;
  edit(request: EditInput, options?: OperationOptions): Promise<EditResult>;
  dispose(): Promise<void>;
}
export interface EditorOptions {
  /** Managed engine resource root. Defaults to ~/.picpatchsdk/engine; never installs implicitly. */
  engineDirectory?: string;
  /** Prepared sd-cli executable at the supported native revision. Never installed automatically. */
  nativeExecutable?: string;
  defaults?: EditDefaults;
  timeouts?: Partial<WorkerTimeouts>;
  /** Experimental offline adapter; the manifest pins caller-supplied files. */
  model?: LocalEditingModel;
}
const defaults = workerTimeouts;

/** Creates a lazy editor. Does not install Python, packages, or models. */
export function createEditor(options: EditorOptions = {}): Editor {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new PicPatchUsageError('INVALID_REQUEST', 'Invalid editor options.');
  if (Object.keys(options).some(key => !['engineDirectory', 'nativeExecutable', 'timeouts', 'model', 'defaults'].includes(key)) ||
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
  if (model && isNativeVariant(model.variant)) {
    if (options.engineDirectory !== undefined || typeof options.nativeExecutable !== 'string' || !isAbsolute(options.nativeExecutable) || options.nativeExecutable.includes('\0')) throw new PicPatchUsageError('INVALID_REQUEST', 'Native models require an absolute nativeExecutable, without engineDirectory.');
    return new ImageEditor(new NativeBackend(options.nativeExecutable, model, timeouts), validateDefaults(options.defaults), model.manifest.model);
  }
  if (options.nativeExecutable !== undefined) throw new PicPatchUsageError('INVALID_REQUEST', 'nativeExecutable requires a native model.');
  const root = resolveStoragePaths(options.engineDirectory === undefined ? {} : { engineDirectory: options.engineDirectory }).engineDirectory;
  return new ImageEditor(new ManagedBackend(root, model, timeouts), validateDefaults(options.defaults), model?.manifest.model);
}
