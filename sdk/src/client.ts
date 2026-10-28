import { modelRuntime } from './models/variants.ts';
import type { ImagePlan, GenerateImagePlan, EditImagePlan } from './images/planning.ts';
import { checkProfile, validateTimeouts, profileDefaults, type PicPatchProfile } from './profile.ts';
import { NativeBackend } from './backends/stable-diffusion-cpp/backend.ts';
import { isNativeVariant } from './backends/stable-diffusion-cpp/models.ts';
import type { ImageDefaults, GenerateInput, EditInput } from './defaults.ts';
import { ManagedBackend } from './backends/python/managed.ts';
import { resolveStoragePaths } from './paths.ts';
import { validateLocalModel } from './models/verification.ts';
import type { LocalModel } from './contracts.generated.ts';
import { ImageClientImpl } from './execution/session.ts';
import { isAbsolute } from 'node:path';
import type { ImageOutcome, OperationOptions, OperationRefusal } from './types.ts';
import { PicPatchSdkError } from './errors.ts';
import { workerTimeouts, type WorkerTimeouts } from './worker/process.ts';
import { catalogModel } from './models/catalog.ts';
import { openModel } from './models/opening.ts';
import type { ModelOpenRefusal, ModelRegistration } from './models/types.ts';
import { inspectNativeEngine } from './runtime/engine/native.ts';
import { withSettings } from './operations.ts';
import type { CallOptions, ModelCapabilities } from './types.ts';

export interface ImageClient {
  plan(request: GenerateInput, options?: OperationOptions): Promise<GenerateImagePlan | OperationRefusal>;
  plan(request: EditInput, options?: OperationOptions): Promise<EditImagePlan | OperationRefusal>;
  plan(request: GenerateInput | EditInput, options?: OperationOptions): Promise<ImagePlan | OperationRefusal>;
  generate(request: GenerateInput | GenerateImagePlan, options?: OperationOptions): Promise<ImageOutcome>;
  edit(request: EditInput | EditImagePlan, options?: OperationOptions): Promise<ImageOutcome>;
  dispose(): Promise<void>;
}
export interface ImageClientOptions {
  profile?: PicPatchProfile;
  /** Managed engine resource root. Defaults to ~/.picpatchsdk/engine; never installs implicitly. */
  engineDirectory?: string;
  /** Prepared sd-cli executable at the supported native revision. Never installed automatically. */
  nativeExecutable?: string;
  defaults?: ImageDefaults;
  timeouts?: Partial<WorkerTimeouts>;
  /** Experimental offline adapter; the manifest pins caller-supplied files. */
  model?: LocalModel;
}
const defaults = workerTimeouts;

/** Creates a lazy image client. Does not install Python, packages, or models. */
export function createImageClient(options: ImageClientOptions = {}): ImageClient {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new PicPatchSdkError('INVALID_REQUEST', 'Invalid image client options.');
  if (Object.keys(options).some(key => !['profile', 'engineDirectory', 'nativeExecutable', 'timeouts', 'model', 'defaults'].includes(key)) ||
      (options.timeouts !== undefined && (typeof options.timeouts !== 'object' || options.timeouts === null || Array.isArray(options.timeouts)))) {
    throw new PicPatchSdkError('INVALID_REQUEST', 'Invalid image client options.');
  }
  const profile = options.profile === undefined ? undefined : checkProfile(options.profile);
  const timeouts = { ...defaults, ...profile?.timeouts, ...validateTimeouts(options.timeouts ?? {}) };
  const settings = profileDefaults(profile, options.defaults);
  let model: LocalModel | undefined;
  if (options.model !== undefined) {
    model = validateLocalModel(options.model);
  }
  if (model && isNativeVariant(model.variant)) {
    const executable = options.nativeExecutable ?? profile?.nativeExecutable;
    if (options.engineDirectory !== undefined || typeof executable !== 'string' || !isAbsolute(executable) || executable.includes('\0')) throw new PicPatchSdkError('INVALID_REQUEST', 'Native models require an absolute nativeExecutable, without engineDirectory.');
    return new ImageClientImpl(new NativeBackend(executable, model, timeouts), settings, model.manifest.model, { backend: 'stable-diffusion.cpp', timeouts });
  }
  if (options.nativeExecutable !== undefined) throw new PicPatchSdkError('INVALID_REQUEST', 'nativeExecutable requires a native model.');
  const engineDirectory = options.engineDirectory ?? profile?.engineDirectory;
  const root = resolveStoragePaths(engineDirectory === undefined ? {} : { engineDirectory }).engineDirectory;
  return new ImageClientImpl(new ManagedBackend(root, model, timeouts), settings, model?.manifest.model, { backend: modelRuntime(model?.variant), timeouts });
}

export interface ImageClientPreparation {
  profile?: PicPatchProfile;
  /** The caller's saved registration for an external model; a pinned model opens from the model store. */
  registration?: ModelRegistration;
}
/** `options` makes a client for the model; equal options make equivalent clients. */
export interface PreparedImageClient { status: 'completed'; options: ImageClientOptions; capabilities: ModelCapabilities }
/**
 * Prepares one run of a catalog model: opens its files (presence only) and, for a native model, checks the native
 * engine. A missing or incompatible engine throws its own code; nothing is installed or loaded.
 */
export async function prepareImageClient(modelId: string, settings: ImageClientPreparation = {}, options: CallOptions = {}): Promise<PreparedImageClient | ModelOpenRefusal> {
  const { profile, registration, ...call } = withSettings(settings, ['profile', 'registration'], options);
  const entry = catalogModel(modelId);
  const store = profile === undefined ? {} : { profile };
  const opened = await openModel(registration ?? modelId, store, call);
  if (opened.status === 'refused') return opened;
  if (entry.runtime.engine !== 'native') return { status: 'completed', capabilities: entry.capabilities, options: { model: opened.model, ...store } };
  const native = await inspectNativeEngine(store, call);
  if (native.status !== 'ready') throw new PicPatchSdkError(native.status === 'missing' ? 'ENGINE_MISSING' : native.status === 'unsupported' ? 'UNSUPPORTED_CAPABILITY' : 'ENGINE_INCOMPATIBLE', native.message);
  return { status: 'completed', capabilities: entry.capabilities, options: { model: opened.model, ...store, nativeExecutable: native.nativeExecutable } };
}
