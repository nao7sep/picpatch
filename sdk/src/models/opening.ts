import { managedEntries, managedRoot as root, type ManagedModelEntry } from './managed.ts';
import { constants } from 'node:fs';
import { open, realpath, stat } from '../storage.ts';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { withDiagnostics } from '../diagnostics.ts';
import type { CallOptions, ModelPresenceIssue } from '../types.ts';
import { newerVersion, versionRefusal } from '../versions.ts';
import { PicPatchSdkError, sdkError } from '../errors.ts';
import { absolutePath, checkSignal, validateOperation, withSettings } from '../operations.ts';
import type { PicPatchProfile } from '../profile.ts';
import { catalogModel, listModels } from './catalog.ts';
import { validateLocalModel } from './verification.ts';

/** The managed model root: modelsDirectory, else the profile's, else the SDK's default. */
export interface ModelStoreSettings {
  profile?: PicPatchProfile;
  modelsDirectory?: string;
}
export interface ModelOpenSettings extends ModelStoreSettings {
  /** Explicit complete catalog bundle. External selections use their saved registration. */
  directory?: string;
}
type ModelOpenOptions = ModelOpenSettings & CallOptions;
export type { ManagedModelInventory, ModelInventoryFailure, ModelOpenRefusal, ModelOpenResult, ModelPresenceIssue, ModelRegistration, ModelRegistrationResult, OpenedModel } from './types.ts';
import type { ManagedModelInventory, ModelOpenRefusal, ModelOpenResult, ModelRegistration, ModelRegistrationResult } from './types.ts';

function checkRegistration(value: unknown): ModelRegistration {
  if (!value || typeof value !== 'object' || Array.isArray(value) || (value as ModelRegistration).version !== 1) throw new PicPatchSdkError('INVALID_REQUEST', 'Invalid model registration.');
  return { version: 1, model: validateLocalModel((value as ModelRegistration).model) };
}
/** Validates a registration the caller holds; a newer format version is refused, as the reader refuses it. */
export function validateModelRegistration(value: unknown): ModelRegistrationResult {
  const version = newerVersion(value);
  if (version !== undefined) return versionRefusal('MODEL_REGISTRATION_VERSION_UNSUPPORTED', 'This model registration version is unsupported.', version);
  return { status: 'completed', registration: checkRegistration(value) };
}
async function presence(registration: ModelRegistration, signal?: AbortSignal): Promise<ModelOpenResult> {
  const model = registration.model;
  const issues: ModelPresenceIssue[] = [];
  for (const component of model.manifest.components) {
    checkSignal(signal);
    const path = join(model.directory, component.path);
    let code: ModelPresenceIssue['code'] | undefined;
    try {
      const base = await realpath(model.directory);
      checkSignal(signal);
      const child = relative(base, await realpath(dirname(path)));
      if (child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) code = 'MODEL_DIRECTORY_ESCAPE';
      else {
        const file = await stat(path);
        if (!file.isFile()) code = 'MODEL_FILE_NOT_REGULAR';
        else if (file.size !== component.bytes) code = 'MODEL_FILE_SIZE_MISMATCH';
      }
    } catch (cause) {
      if (['ENOENT', 'ENOTDIR'].includes((cause as NodeJS.ErrnoException).code ?? '')) code = 'MODEL_FILE_MISSING'; else throw cause;
    }
    if (code) issues.push({ path, code, message: 'Model component is not present at its declared location and size.', effect: 'none' });
  }
  checkSignal(signal);
  return issues.length ? { status: 'refused', code: 'MODEL_INCOMPLETE', message: 'The model bundle is incomplete; existing files were preserved.', subject: model.directory, details: { issues } } : { ...registration, status: 'completed', integrity: 'presence-only', compatibility: 'unknown' };
}
async function boundary<T>(options: ModelOpenOptions, action: (signal?: AbortSignal) => Promise<T>): Promise<T> {
  validateOperation(options, ['profile', 'modelsDirectory', 'directory']);
  if (options.directory !== undefined) absolutePath(options.directory);
  root(options);
  checkSignal(options.signal);
  try { return await action(options.signal); }
  catch (cause) { if (cause instanceof PicPatchSdkError) throw cause; throw new PicPatchSdkError('MODEL_IO', 'Could not open model files.', { cause }); }
}
function select(input: string | ModelRegistration, options: ModelOpenOptions): ModelRegistration | ModelOpenRefusal {
  if (typeof input !== 'string') {
    if (options.directory !== undefined) throw new PicPatchSdkError('INVALID_REQUEST', 'A registration already names its directory.');
    const valid = validateModelRegistration(input);
    return valid.status === 'refused' ? valid : valid.registration;
  }
  const entry = catalogModel(input);
  if (entry.acquisition !== 'pinned') throw new PicPatchSdkError('INVALID_REQUEST', 'Prepare an external selection once and pass its saved registration to openModel.');
  return { version: 1, model: { variant: entry.variant, directory: options.directory ?? join(root(options), entry.id, entry.manifest.source.revision), manifest: entry.manifest } };
}
/** Cheap presence only: never reads model contents, installs packages or starts inference. */
export function openModel(input: string | ModelRegistration, settings: ModelOpenSettings = {}, options: CallOptions = {}): Promise<ModelOpenResult> {
  return withDiagnostics('openModel', options, call => { const operation = withSettings(settings, ['profile', 'modelsDirectory', 'directory'], call); return boundary(operation, async signal => {
    const registration = select(input, operation);
    return 'status' in registration ? registration : presence(registration, signal);
  }); });
}
/** Reads only the explicitly selected registration file. The caller owns its persistence. */
export function readModelRegistration(path: string, options: CallOptions = {}): Promise<ModelRegistrationResult> {
  return withDiagnostics('readModelRegistration', options, operation => boundary(withSettings({}, [], operation), async signal => {
    absolutePath(path); checkSignal(signal);
    const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      if (!(await file.stat()).isFile()) throw new PicPatchSdkError('INVALID_REQUEST', 'A registration must be a regular file.', { subject: path });
      checkSignal(signal);
      const bytes = await file.readFile({ encoding: 'utf8', signal });
      checkSignal(signal);
      let value: unknown;
      try { value = JSON.parse(bytes); } catch (cause) { throw new PicPatchSdkError('INVALID_REQUEST', 'Invalid model registration JSON.', { cause, subject: path }); }
      const result = validateModelRegistration(value);
      return result.status === 'refused' ? { ...result, subject: path } : result;
    } finally { await file.close(); }
  }));
}
/** Catalog inventory in one selected SDK resource root; arbitrary folders use discoverModels. */
export function inspectModels(settings: ModelStoreSettings = {}, options: CallOptions = {}): Promise<ManagedModelInventory> {
  return withDiagnostics('inspectModels', options, call => { const operation = withSettings(settings, ['profile', 'modelsDirectory'], call); return boundary(operation, async signal => {
    const models: ManagedModelInventory['models'] = [];
    const entries: ManagedModelEntry[] = [];
    for (const entry of listModels()) {
      if (entry.acquisition !== 'pinned') continue;
      const registration = select(entry.id, operation) as ModelRegistration;
      let result: ModelOpenResult;
      try {
        entries.push(...await managedEntries(root(operation), entry.id, entry.manifest.source.revision, signal));
        result = await presence(registration, signal);
      }
      catch (cause) {
        checkSignal(signal);
        const error = sdkError(cause instanceof PicPatchSdkError ? cause : new PicPatchSdkError('MODEL_IO', 'Could not inspect this model bundle.', { cause, subject: registration.model.directory }));
        models.push({ id: entry.id, directory: registration.model.directory, status: 'failed', result: { status: 'failed', error: error.toJSON() } });
        continue;
      }
      const missing = result.status === 'refused' && (result.details.issues ?? []).every(issue => issue.code === 'MODEL_FILE_MISSING');
      models.push({ id: entry.id, directory: registration.model.directory, status: result.status === 'completed' ? 'present' : missing ? 'missing' : 'incomplete', result });
    }
    return { models, entries };
  }); });
}
