import { createHash } from 'node:crypto';
import { release } from 'node:os';
import { join } from 'node:path';
import { chmod, lstat, mkdir, mkdtemp, open, readdir, rename, rm, storageCleanup, storageRecovery, storageStalled } from '../../storage.ts';
import { PicPatchSdkError } from '../../errors.ts';
import { operationStage, withDiagnostics } from '../../diagnostics.ts';
import { checkSignal, timeBudget, validateOperation, withDeadline } from '../../operations.ts';
import { resolveStoragePaths } from '../../paths.ts';
import { validateProfile } from '../../profile.ts';
import { downloadFile } from '../download.ts';
import { runCommand } from './command.ts';
import type { EngineOptions } from './types.ts';

import { nativeRelease } from './native-release.ts';
const nativeRevision = nativeRelease.revision;
export interface ReadyNativeEngine { status: 'ready'; code: 'ENGINE_READY'; message: string; engineDirectory: string; nativeExecutable: string; revision: string }
export type NativeEngineInspection = ReadyNativeEngine | { status: 'missing' | 'incompatible'; code: 'ENGINE_MISSING' | 'ENGINE_CHECK_FAILED'; message: string; engineDirectory: string; revision: string };
export interface NativeEngineInstallation extends ReadyNativeEngine { origin: 'installed' | 'reused'; cleanupWarning?: { directory: string; message: string } }
const missing = (cause: unknown) => ['ENOENT', 'ENOTDIR'].includes((cause as NodeJS.ErrnoException)?.code ?? '');
function root(options: EngineOptions): string {
  validateOperation(options, ['profile', 'engineDirectory']);
  if ('onProgress' in options) throw new PicPatchSdkError('INVALID_REQUEST', 'Engine operations report stages through onEvent.');
  const profile = options.profile === undefined ? undefined : validateProfile(options.profile);
  const engineDirectory = options.engineDirectory ?? profile?.engineDirectory;
  const result = resolveStoragePaths(engineDirectory === undefined ? {} : { engineDirectory }).engineDirectory;
  if (process.platform !== 'darwin' || process.arch !== 'arm64' || Number(release().split('.')[0]) < 25) throw new PicPatchSdkError('UNSUPPORTED_CAPABILITY', 'This managed native build requires macOS 26 or newer on Apple Silicon.');
  return result;
}
const installation = (root: string) => join(root, 'native', `darwin-arm64-${nativeRelease.sha256}`);
const env = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'en_US.UTF-8' };
async function sync(path: string): Promise<void> {
  const file = await open(path, 'r'); try { await file.sync(); } finally { await file.close(); }
}
async function inspect(root: string, signal: AbortSignal): Promise<NativeEngineInspection> {
  const directory = installation(root);
  const base = { engineDirectory: root, revision: nativeRevision };
  let found = false;
  try {
    const info = await lstat(directory); found = true;
    if (!info.isDirectory() || info.isSymbolicLink()) return { ...base, status: 'incompatible', code: 'ENGINE_CHECK_FAILED', message: 'The native engine did not pass its readiness checks.' };
    for (const [name, bytes] of Object.entries(nativeRelease.files)) {
      const file = await lstat(join(directory, name));
      if (!file.isFile() || file.size !== bytes) return { ...base, status: 'incompatible', code: 'ENGINE_CHECK_FAILED', message: 'The native engine did not pass its readiness checks.' };
    }
  } catch (cause) { if (missing(cause)) return { ...base, status: found ? 'incompatible' : 'missing', code: found ? 'ENGINE_CHECK_FAILED' : 'ENGINE_MISSING', message: found ? 'The native engine installation is incomplete.' : 'The native engine is not installed.' }; throw cause; }
  const nativeExecutable = join(directory, 'sd-cli');
  try {
    const output = await runCommand(nativeExecutable, ['--help'], directory, env, signal, 15_000);
    const commit = output.match(/^stable-diffusion\.cpp version [^\n]+, commit ([a-f0-9]{7,40})\b/)?.[1];
    if (!commit || !nativeRevision.startsWith(commit)) return { ...base, status: 'incompatible', code: 'ENGINE_CHECK_FAILED', message: 'The native engine did not pass its readiness checks.' };
  } catch (cause) {
    if (cause instanceof PicPatchSdkError && ['INSTALL_FAILED', 'ENGINE_UNAVAILABLE'].includes(cause.code)) return { ...base, status: 'incompatible', code: 'ENGINE_CHECK_FAILED', message: 'The native engine did not pass its readiness checks.' };
    throw cause;
  }
  return { ...base, status: 'ready', code: 'ENGINE_READY', message: 'The native engine is ready.', nativeExecutable };
}
/** Read-only runtime probe; does not acquire files or load models. */
export function inspectNativeEngine(options: EngineOptions = {}) {
  return withDiagnostics('inspectNativeEngine', options, operation => {
    const directory = root(operation);
    return withDeadline(operation.signal, timeBudget(operation.timeoutMs, 60_000), 'Native engine inspection timed out.', async signal => {
      try { return await inspect(directory, signal); }
      catch (cause) { if (cause instanceof PicPatchSdkError) throw cause; throw new PicPatchSdkError('ENGINE_IO', 'Could not inspect the native engine.', { cause }); }
    });
  });
}
/** Explicit acquisition. Pass the returned nativeExecutable to an editor or profile. No implicit install. */
export function installNativeEngine(options: EngineOptions = {}) {
  return withDiagnostics('installNativeEngine', options, operation => install(operation));
}
async function install(options: EngineOptions): Promise<NativeEngineInstallation> {
  const directory = root(options);
  let completed: NativeEngineInstallation | undefined;
  return withDeadline(options.signal, timeBudget(options.timeoutMs, 600_000), 'Native engine installation timed out.', async signal => {
    operationStage(options, 'checking', 'Checking the native engine.');
    const existing = await inspect(directory, signal);
    if (existing.status === 'ready') return { ...existing, origin: 'reused' as const };
    // Unknown/incomplete contents are preserved, not repaired in place.
    try { await lstat(installation(directory)); throw new PicPatchSdkError('ENGINE_INCOMPATIBLE', 'Existing native installation is incomplete or incompatible; it was preserved.'); }
    catch (cause) { if (!missing(cause)) throw cause; }
    const parent = join(directory, 'native');
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const staging = await mkdtemp(join(parent, '.install-'));
    storageRecovery(staging);
    let publicationAttempted = false;
    try {
      const archive = join(staging, 'runtime.zip');
      const extracted = join(staging, 'runtime');
      await mkdir(extracted, { mode: 0o700 });
      operationStage(options, 'installing', 'Downloading the pinned native engine.');
      await downloadFile(nativeRelease.url, archive, nativeRelease.bytes, signal, fetch, 'ENGINE_IO');
      const file = await open(archive, 'r');
      try {
        const hash = createHash('sha256'); const buffer = Buffer.alloc(1024 * 1024); let position = 0;
        for (;;) {
          checkSignal(signal);
          const { bytesRead } = await file.read(buffer, 0, buffer.length, position);
          if (!bytesRead) break;
          position += bytesRead; hash.update(buffer.subarray(0, bytesRead));
        }
        if (hash.digest('hex') !== nativeRelease.sha256) throw new PicPatchSdkError('ENGINE_INCOMPATIBLE', 'Native archive integrity did not match the pinned release.');
      } finally { await file.close(); }
      // Only the independently authenticated, fixed archive is extracted, and only these flat entries.
      await runCommand('/usr/bin/tar', ['-xf', archive, '-C', extracted, ...Object.keys(nativeRelease.files)], staging, env, signal, 60_000);
      for (const [name, bytes] of Object.entries(nativeRelease.files)) {
        const path = join(extracted, name); const info = await lstat(path);
        if (!info.isFile() || info.size !== bytes) throw new PicPatchSdkError('ENGINE_INCOMPATIBLE', 'Extracted native files did not match the release.');
        await chmod(path, name.endsWith('.txt') ? 0o600 : 0o700);
        await sync(path);
      }
      if ((await readdir(extracted)).length !== Object.keys(nativeRelease.files).length) throw new PicPatchSdkError('ENGINE_INCOMPATIBLE', 'Unexpected native archive contents.');
      for (const name of ['sd-cli', 'libstable-diffusion.dylib']) await runCommand('/usr/bin/lipo', ['-verify_arch', 'arm64', join(extracted, name)], staging, env, signal, 15_000);
      await runCommand('/usr/bin/xattr', ['-cr', extracted], staging, env, signal, 15_000);
      const output = await runCommand(join(extracted, 'sd-cli'), ['--help'], extracted, env, signal, 15_000);
      if (!output.startsWith(`stable-diffusion.cpp version unknown, commit ${nativeRevision.slice(0, 7)}\n`)) throw new PicPatchSdkError('ENGINE_INCOMPATIBLE', 'Native engine probe did not match the pinned release.');
      await sync(extracted);
      operationStage(options, 'publishing', 'Publishing the verified native engine.');
      checkSignal(signal); publicationAttempted = true;
      try { await rename(extracted, installation(directory)); }
      catch (cause) {
        if (!['EEXIST', 'ENOTEMPTY'].includes((cause as NodeJS.ErrnoException).code ?? '')) throw cause;
        const winner = await inspect(directory, signal);
        if (winner.status !== 'ready') throw new PicPatchSdkError('ENGINE_INCOMPATIBLE', 'A conflicting native installation was preserved.');
      }
      await sync(parent);
      completed = { status: 'ready', code: 'ENGINE_READY', message: 'The native engine is ready.', engineDirectory: directory, nativeExecutable: join(installation(directory), 'sd-cli'), revision: nativeRevision, origin: 'installed' };
      await storageCleanup(() => rm(staging, { recursive: true, force: true }));
      return completed;
    } catch (cause) {
      if (completed) { completed.cleanupWarning = { directory: staging, message: 'Native engine is ready; staging cleanup failed.' }; return completed; }
      const error = cause instanceof PicPatchSdkError ? cause : new PicPatchSdkError('ENGINE_IO', 'Native engine installation failed.', { cause });
      if (storageStalled() || publicationAttempted || error.code === 'TERMINATION_FAILED') { error.effect = 'unknown'; error.details.recoveryDirectory = staging; }
      else {
        try { await storageCleanup(() => rm(staging, { recursive: true, force: true })); }
        catch (cleanup) { throw new PicPatchSdkError('CLEANUP_FAILED', 'Native installation failed and staging could not be removed.', { cause: new AggregateError([cause, cleanup]), effect: 'unknown', details: { recoveryDirectory: staging } }); }
      }
      throw error;
    }
  }).catch(cause => { if (completed) return completed; if (cause instanceof PicPatchSdkError) throw cause; throw new PicPatchSdkError('ENGINE_IO', 'Could not install the native engine.', { cause }); });
}
