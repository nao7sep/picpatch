import { constants } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { withDiagnostics, type EventOptions } from '../diagnostics.ts';
import { PicPatchSdkError } from '../errors.ts';
import { absolutePath, checkSignal, timeBudget, validateOperation, withDeadline } from '../operations.ts';
import { resolveStoragePaths } from '../paths.ts';
import { validateProfile, type PicPatchProfile } from '../profile.ts';
import type { LocalEditingModel } from '../contracts.generated.ts';
import { catalogModel, listModels } from './catalog.ts';
import { validateLocalEditingModel } from './verification.ts';

/** Persist this envelope, not an inference session or historical verification claim. */
export interface ModelRegistration { version: 1; model: LocalEditingModel }
export interface ModelOpenOptions extends EventOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  profile?: PicPatchProfile;
  modelsDirectory?: string;
  /** Explicit complete catalog bundle. External selections use their saved registration. */
  directory?: string;
}
export interface ModelPresenceIssue {
  path: string;
  code: 'MODEL_FILE_MISSING' | 'MODEL_FILE_NOT_REGULAR' | 'MODEL_FILE_SIZE_MISMATCH' | 'MODEL_DIRECTORY_ESCAPE';
  message: string;
  effect: 'none';
}
export interface OpenedModel extends ModelRegistration {
  status: 'ready';
  integrity: 'presence-only';
  compatibility: 'unknown';
}
export interface ModelOpenRefusal {
  status: 'refused';
  code: 'MODEL_INCOMPLETE' | 'MODEL_REGISTRATION_VERSION_UNSUPPORTED';
  message: string;
  effect: 'none';
  issues: ModelPresenceIssue[];
}
export type ModelOpenResult = OpenedModel | ModelOpenRefusal;
export interface ManagedModelInventory { models: { id: string; directory: string; status: 'present' | 'missing' | 'incomplete'; result: ModelOpenResult }[] }

export function validateModelRegistration(value: unknown): ModelRegistration {
  if (!value || typeof value !== 'object' || Array.isArray(value) || (value as ModelRegistration).version !== 1) throw new PicPatchSdkError('INVALID_REQUEST', 'Invalid model registration.');
  return { version: 1, model: validateLocalEditingModel((value as ModelRegistration).model) };
}
function unsupported(value: unknown): ModelOpenRefusal | undefined {
  const version = (value as { version?: unknown } | null)?.version;
  if (typeof version === 'number' && Number.isInteger(version) && version !== 1) return { status: 'refused', code: 'MODEL_REGISTRATION_VERSION_UNSUPPORTED', message: 'This model registration version is unsupported.', effect: 'none', issues: [] };
}
function root(options: ModelOpenOptions): string {
  const profile = options.profile === undefined ? undefined : validateProfile(options.profile);
  const modelsDirectory = options.modelsDirectory ?? profile?.modelsDirectory;
  return resolveStoragePaths(modelsDirectory === undefined ? {} : { modelsDirectory }).modelsDirectory;
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
  return issues.length ? { status: 'refused', code: 'MODEL_INCOMPLETE', message: 'The model bundle is incomplete; existing files were preserved.', effect: 'none', issues } : { ...registration, status: 'ready', integrity: 'presence-only', compatibility: 'unknown' };
}
async function boundary<T>(options: ModelOpenOptions, action: (signal: AbortSignal) => Promise<T>): Promise<T> {
  validateOperation(options, ['profile', 'modelsDirectory', 'directory']);
  if (options.directory !== undefined) absolutePath(options.directory);
  root(options);
  try { return await withDeadline(options.signal, timeBudget(options.timeoutMs, 60_000), 'Model opening timed out.', action); }
  catch (cause) { if (cause instanceof PicPatchSdkError) throw cause; throw new PicPatchSdkError('MODEL_IO', 'Could not open model files.', { cause }); }
}
function select(input: string | ModelRegistration, options: ModelOpenOptions): ModelRegistration | ModelOpenRefusal {
  if (typeof input !== 'string') {
    if (options.directory !== undefined) throw new PicPatchSdkError('INVALID_REQUEST', 'A registration already names its directory.');
    return unsupported(input) ?? validateModelRegistration(input);
  }
  const entry = catalogModel(input);
  if (entry.acquisition !== 'pinned') throw new PicPatchSdkError('INVALID_REQUEST', 'Prepare an external selection once and pass its saved registration to openModel.');
  return { version: 1, model: { variant: entry.variant, directory: options.directory ?? join(root(options), entry.id, entry.manifest.source.revision), manifest: entry.manifest } };
}
/** Cheap presence only: never reads model contents, installs packages or starts inference. */
export function openModel(input: string | ModelRegistration, options: ModelOpenOptions = {}): Promise<ModelOpenResult> {
  return withDiagnostics('openModel', options, operation => boundary(operation, async signal => {
    const registration = select(input, operation);
    return 'status' in registration ? registration : presence(registration, signal);
  }));
}
/** Reads only the explicitly selected registration file. The caller owns its persistence. */
export function readModelRegistration(path: string, options: ModelOpenOptions = {}): Promise<ModelRegistration | ModelOpenRefusal> {
  return withDiagnostics('readModelRegistration', options, operation => boundary(operation, async signal => {
    absolutePath(path); checkSignal(signal);
    const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      if (!(await file.stat()).isFile()) throw new PicPatchSdkError('INVALID_REQUEST', 'A registration must be a regular file.', { subject: path });
      checkSignal(signal);
      const bytes = await file.readFile({ encoding: 'utf8', signal });
      checkSignal(signal);
      let value: unknown;
      try { value = JSON.parse(bytes); } catch (cause) { throw new PicPatchSdkError('INVALID_REQUEST', 'Invalid model registration JSON.', { cause, subject: path }); }
      return unsupported(value) ?? validateModelRegistration(value);
    } finally { await file.close(); }
  }));
}
/** Catalog inventory in one selected SDK resource root; arbitrary folders use discoverModels. */
export function inspectModels(options: ModelOpenOptions = {}): Promise<ManagedModelInventory> {
  return withDiagnostics('inspectModels', options, operation => boundary(operation, async signal => {
    if (operation.directory !== undefined) throw new PicPatchSdkError('INVALID_REQUEST', 'Inventory takes a model root, not one bundle directory.');
    const models: ManagedModelInventory['models'] = [];
    for (const entry of listModels()) {
      if (entry.acquisition !== 'pinned') continue;
      const registration = select(entry.id, operation) as ModelRegistration;
      const result = await presence(registration, signal);
      const missing = result.status === 'refused' && result.issues.every(issue => issue.code === 'MODEL_FILE_MISSING');
      models.push({ id: entry.id, directory: registration.model.directory, status: result.status === 'ready' ? 'present' : missing ? 'missing' : 'incomplete', result });
    }
    return { models };
  }));
}
