import { constants } from 'node:fs';
import { open } from './storage.ts';
import { validateDefaults, type ImageDefaults } from './defaults.ts';
import { PicPatchSdkError } from './errors.ts';
import { withDiagnostics } from './diagnostics.ts';
import { newerVersion, versionRefusal } from './versions.ts';
import type { CallOptions, Refusal } from './types.ts';
import { absolutePath, checkSignal, timeBudget, validateOperation, withDeadline } from './operations.ts';
import { workerTimeouts } from './worker/process.ts';
import type { WorkerTimeouts } from './types.ts';

export type { PicPatchProfile } from './types.ts';
import type { PicPatchProfile } from './types.ts';
export type ProfileReadOptions = CallOptions;
export type ProfileRefusal = Refusal<'PROFILE_VERSION_UNSUPPORTED'>;
export type ProfileReadResult = { status: 'completed'; profile: PicPatchProfile } | ProfileRefusal;

export function validateTimeouts(value: unknown): Partial<WorkerTimeouts> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new PicPatchSdkError('INVALID_REQUEST', 'Invalid worker timeouts.');
  for (const [key, duration] of Object.entries(value)) {
    if (!Object.hasOwn(workerTimeouts, key)) throw new PicPatchSdkError('INVALID_REQUEST', 'Unknown worker timeout.');
    timeBudget(duration, workerTimeouts[key as keyof WorkerTimeouts]!);
  }
  return Object.fromEntries(Object.entries(value).filter(([, duration]) => duration !== undefined));
}
/** Validates a profile the caller holds; a newer format version is refused, as readProfile refuses it. */
export function validateProfile(value: unknown): ProfileReadResult {
  const version = newerVersion(value);
  if (version !== undefined) return versionRefusal('PROFILE_VERSION_UNSUPPORTED', 'This profile version is unsupported.', version);
  return { status: 'completed', profile: checkProfile(value) };
}
/** Throws for an invalid or newer profile; a verb cannot run with one. */
export function checkProfile(value: unknown): PicPatchProfile {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['version', 'engineDirectory', 'modelsDirectory', 'nativeExecutable', 'defaults', 'timeouts'].includes(key))) throw new PicPatchSdkError('INVALID_REQUEST', 'Invalid profile fields.');
  const profile = value as PicPatchProfile;
  if (profile.version !== 1) throw new PicPatchSdkError('INVALID_REQUEST', 'Unsupported profile version.');
  for (const key of ['engineDirectory', 'modelsDirectory', 'nativeExecutable'] as const) if (profile[key] !== undefined) absolutePath(profile[key]);
  if (profile.defaults !== undefined) validateDefaults(profile.defaults);
  const timeouts = profile.timeouts === undefined ? undefined : validateTimeouts(profile.timeouts);
  return { ...structuredClone(profile), ...(timeouts ? { timeouts } : {}) };
}

/** Undefined explicit values inherit; nested sampling and timeout overrides merge by field. */
export function profileDefaults(profile: PicPatchProfile | undefined, explicit: ImageDefaults | undefined): ImageDefaults {
  const base = profile === undefined ? {} : checkProfile(profile).defaults ?? {};
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
        const result = validateProfile(value);
        return result.status === 'refused' ? { ...result, subject: path } : result;
      } catch (cause) {
        checkSignal(signal);
        if (cause instanceof PicPatchSdkError) throw cause;
        throw new PicPatchSdkError('PROFILE_IO', 'Could not read the profile.', { cause, subject: path });
      } finally { await file?.close(); }
    });
  });
}
