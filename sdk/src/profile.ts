import { constants } from 'node:fs';
import { open } from './storage.ts';
import { validateDefaults, type EditDefaults } from './defaults.ts';
import { PicPatchSdkError } from './errors.ts';
import { withDiagnostics, type EventOptions } from './diagnostics.ts';
import { absolutePath, checkSignal, timeBudget, validateOperation, withDeadline } from './operations.ts';
import { workerTimeouts, type WorkerTimeouts } from './worker/process.ts';

/** Caller-owned argument bundle. Paths are absolute literals; never discovered or written by the SDK. */
export interface PicPatchProfile {
  version: 1;
  engineDirectory?: string;
  modelsDirectory?: string;
  nativeExecutable?: string;
  defaults?: EditDefaults;
  timeouts?: Partial<WorkerTimeouts>;
}
export interface ProfileReadOptions extends EventOptions { signal?: AbortSignal; timeoutMs?: number }
export interface ProfileRefusal { status: 'refused'; code: 'PROFILE_VERSION_UNSUPPORTED'; message: string; effect: 'none'; subject: string; version: number }
export type ProfileReadResult = import('./logging.ts').Logged<{ status: 'read'; profile: PicPatchProfile } | ProfileRefusal>;

export function validateTimeouts(value: unknown): Partial<WorkerTimeouts> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new PicPatchSdkError('INVALID_REQUEST', 'Invalid worker timeouts.');
  for (const [key, duration] of Object.entries(value)) {
    if (!Object.hasOwn(workerTimeouts, key)) throw new PicPatchSdkError('INVALID_REQUEST', 'Unknown worker timeout.');
    timeBudget(duration, workerTimeouts[key as keyof WorkerTimeouts]!);
  }
  return Object.fromEntries(Object.entries(value).filter(([, duration]) => duration !== undefined));
}
export function validateProfile(value: unknown): PicPatchProfile {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['version', 'engineDirectory', 'modelsDirectory', 'nativeExecutable', 'defaults', 'timeouts'].includes(key))) throw new PicPatchSdkError('INVALID_REQUEST', 'Invalid profile fields.');
  const profile = value as PicPatchProfile;
  if (profile.version !== 1) throw new PicPatchSdkError('INVALID_REQUEST', 'Unsupported profile version.');
  for (const key of ['engineDirectory', 'modelsDirectory', 'nativeExecutable'] as const) if (profile[key] !== undefined) absolutePath(profile[key]);
  if (profile.defaults !== undefined) validateDefaults(profile.defaults);
  const timeouts = profile.timeouts === undefined ? undefined : validateTimeouts(profile.timeouts);
  return { ...structuredClone(profile), ...(timeouts ? { timeouts } : {}) };
}

/** Undefined explicit values inherit; nested sampling and timeout overrides merge by field. */
export function profileDefaults(profile: PicPatchProfile | undefined, explicit: EditDefaults | undefined): EditDefaults {
  const base = profile === undefined ? {} : validateProfile(profile).defaults ?? {};
  const overrides = explicit === undefined ? {} : validateDefaults(explicit);
  const defined = Object.fromEntries(Object.entries(overrides).filter(([, value]) => value !== undefined));
  return validateDefaults({ ...base, ...defined, ...(base.parameters || overrides.parameters ? { parameters: { ...base.parameters, ...Object.fromEntries(Object.entries(overrides.parameters ?? {}).filter(([, value]) => value !== undefined)) } } : {}) });
}

export function readProfile(path: string, options: ProfileReadOptions = {}): Promise<ProfileReadResult> {
  return withDiagnostics('readProfile', options, async operation => {
    absolutePath(path); validateOperation(operation);
    return withDeadline(operation.signal, timeBudget(operation.timeoutMs, 30_000), 'Profile read timed out.', async signal => {
      checkSignal(signal);
      let file;
      try {
        file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
        if (!(await file.stat()).isFile()) throw new PicPatchSdkError('INVALID_REQUEST', 'Profiles must be regular files.', { subject: path });
        checkSignal(signal);
        const bytes = await file.readFile({ encoding: 'utf8', signal });
        checkSignal(signal);
        let value: unknown;
        try { value = JSON.parse(bytes); }
        catch (cause) { throw new PicPatchSdkError('INVALID_REQUEST', 'Profile contains invalid JSON.', { cause, subject: path }); }
        const version = (value as { version?: unknown } | null)?.version;
        if (typeof version === 'number' && Number.isInteger(version) && version !== 1) return { status: 'refused', code: 'PROFILE_VERSION_UNSUPPORTED', message: 'This profile version is unsupported.', effect: 'none', subject: path, version };
        return { status: 'read' as const, profile: validateProfile(value) };
      } catch (cause) {
        checkSignal(signal);
        if (cause instanceof PicPatchSdkError) throw cause;
        throw new PicPatchSdkError('PROFILE_IO', 'Could not read the profile.', { cause, subject: path });
      } finally { await file?.close(); }
    });
  });
}
