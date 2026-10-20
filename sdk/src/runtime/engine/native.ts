import { createHash } from 'node:crypto';
import { release } from 'node:os';
import { dirname, join } from 'node:path';
import { chmod, lstat, mkdir, mkdtemp, open, readdir, rename, rm, storageCleanup, storageRecovery, storageStalled } from '../../storage.ts';
import { PicPatchSdkError } from '../../errors.ts';
import { operationStage, withDiagnostics } from '../../diagnostics.ts';
import { absolutePath, checkSignal, timeBudget, validateOperation, withDeadline, withSettings } from '../../operations.ts';
import { resolveStoragePaths } from '../../paths.ts';
import { checkProfile } from '../../profile.ts';
import { downloadFile } from '../download.ts';
import { runCommand } from './command.ts';
import type { NativeEngineInspection, NativeEngineInstallation, NativeEngineSettings, NativeInspectionSettings } from './types.ts';
import type { CallOptions } from '../../types.ts';
type NativeEngineOptions = NativeEngineSettings & CallOptions;
type NativeInspectionOptions = NativeInspectionSettings & CallOptions;

import { nativeReleaseFor, nativeRevision, type NativeRelease } from './native-release.ts';
import { archiveTool, currentHost, hostId, syncDirectory, syncFile, toolEnvironment } from '../../platform.ts';
export type { NativeEngineInspection, NativeEngineInstallation, ReadyNativeEngine } from './types.ts';
const missing = (cause: unknown) => ['ENOENT', 'ENOTDIR'].includes((cause as NodeJS.ErrnoException)?.code ?? '');
function nativeLocation(options: NativeInspectionOptions, keys: string[]): { root: string; nativeExecutable?: string } {
  validateOperation(options, ['profile', 'engineDirectory', ...keys]);
  const profile = options.profile === undefined ? undefined : checkProfile(options.profile);
  const engineDirectory = options.engineDirectory ?? profile?.engineDirectory;
  const nativeExecutable = options.nativeExecutable ?? profile?.nativeExecutable;
  if (nativeExecutable !== undefined) absolutePath(nativeExecutable);
  return { root: resolveStoragePaths(engineDirectory === undefined ? {} : { engineDirectory }).engineDirectory, ...(nativeExecutable === undefined ? {} : { nativeExecutable }) };
}
const root = (options: NativeEngineOptions) => nativeLocation(options, []).root;
/** The pinned build for this computer; the macOS build needs macOS 26 (Darwin 25) or newer. */
function hostRelease(): NativeRelease | undefined {
  if (process.platform === 'darwin' && Number(release().split('.')[0]) < 25) return undefined;
  return nativeReleaseFor(currentHost());
}
function requireRelease(): NativeRelease {
  const pinned = hostRelease();
  if (!pinned) throw new PicPatchSdkError('UNSUPPORTED_CAPABILITY', 'The managed native engine needs macOS 26 or newer on Apple Silicon, or 64-bit Windows.');
  return pinned;
}
const installation = (root: string, pinned: NativeRelease) => join(root, 'native', `${hostId()}-${pinned.sha256}`);
const env = toolEnvironment();
/** 0xC0000135: Windows could not load a DLL the executable needs, here the Visual C++ runtime. */
const missingDll = (cause: unknown) => cause instanceof PicPatchSdkError && [3221225781, -1073741515].includes(Number((cause.details.diagnostic as { exitCode?: number } | undefined)?.exitCode));
/** The commit an sd-cli --help banner names; Windows ends its lines with CRLF. */
export const probeCommit = (output: string) => output.match(/^stable-diffusion\.cpp version [^\r\n]+, commit ([a-f0-9]{7,40})\b/)?.[1];
/** Probes a configured executable: it must run here and name the pinned revision. */
async function inspectConfigured(root: string, nativeExecutable: string, signal: AbortSignal): Promise<NativeEngineInspection> {
  const base = { engineDirectory: root, revision: nativeRevision };
  try {
    const commit = probeCommit(await runCommand(nativeExecutable, ['--help'], dirname(nativeExecutable), env, signal, 15_000));
    if (!commit || !nativeRevision.startsWith(commit)) return { ...base, status: 'incompatible', code: 'ENGINE_CHECK_FAILED', message: 'The configured native executable is not the supported revision.' };
  } catch (cause) {
    if (cause instanceof PicPatchSdkError && cause.code === 'ENGINE_UNAVAILABLE' && missing(cause.cause)) return { ...base, status: 'missing', code: 'ENGINE_MISSING', message: 'The configured native executable was not found.' };
    if (cause instanceof PicPatchSdkError && ['INSTALL_FAILED', 'ENGINE_UNAVAILABLE'].includes(cause.code)) return { ...base, status: 'incompatible', code: 'ENGINE_CHECK_FAILED', message: 'The configured native executable did not pass its readiness checks.' };
    throw cause;
  }
  return { ...base, status: 'ready', code: 'ENGINE_READY', message: 'The configured native executable is ready.', nativeExecutable };
}
async function inspect(root: string, signal: AbortSignal): Promise<NativeEngineInspection> {
  const base = { engineDirectory: root, revision: nativeRevision };
  const pinned = hostRelease();
  if (!pinned) return { ...base, status: 'unsupported', code: 'UNSUPPORTED_CAPABILITY', message: 'The native engine has no build for this computer.' };
  const directory = installation(root, pinned);
  let found = false;
  try {
    const info = await lstat(directory); found = true;
    if (!info.isDirectory() || info.isSymbolicLink()) return { ...base, status: 'incompatible', code: 'ENGINE_CHECK_FAILED', message: 'The native engine did not pass its readiness checks.' };
    for (const [name, bytes] of Object.entries(pinned.files)) {
      const file = await lstat(join(directory, name));
      if (!file.isFile() || file.size !== bytes) return { ...base, status: 'incompatible', code: 'ENGINE_CHECK_FAILED', message: 'The native engine did not pass its readiness checks.' };
    }
  } catch (cause) { if (missing(cause)) return { ...base, status: found ? 'incompatible' : 'missing', code: found ? 'ENGINE_CHECK_FAILED' : 'ENGINE_MISSING', message: found ? 'The native engine installation is incomplete.' : 'The native engine is not installed.' }; throw cause; }
  const nativeExecutable = join(directory, pinned.executable);
  try {
    const output = await runCommand(nativeExecutable, ['--help'], directory, env, signal, 15_000);
    const commit = probeCommit(output);
    if (!commit || !nativeRevision.startsWith(commit)) return { ...base, status: 'incompatible', code: 'ENGINE_CHECK_FAILED', message: 'The native engine did not pass its readiness checks.' };
  } catch (cause) {
    if (cause instanceof PicPatchSdkError && ['INSTALL_FAILED', 'ENGINE_UNAVAILABLE'].includes(cause.code)) return { ...base, status: 'incompatible', code: 'ENGINE_CHECK_FAILED', message: 'The native engine did not pass its readiness checks.' };
    throw cause;
  }
  return { ...base, status: 'ready', code: 'ENGINE_READY', message: 'The native engine is ready.', nativeExecutable };
}
/** Read-only runtime probe of the managed installation, or of a configured executable; does not acquire files or load models. */
export function inspectNativeEngine(settings: NativeInspectionSettings = {}, options: CallOptions = {}): Promise<NativeEngineInspection> {
  return withDiagnostics('inspectNativeEngine', options, call => {
    const operation = withSettings(settings, ['profile', 'engineDirectory', 'nativeExecutable'], call);
    const { root: directory, nativeExecutable } = nativeLocation(operation, ['nativeExecutable']);
    return withDeadline(operation.signal, timeBudget(operation.timeoutMs, 60_000), 'Native engine inspection timed out.', async signal => {
      try { return await (nativeExecutable === undefined ? inspect(directory, signal) : inspectConfigured(directory, nativeExecutable, signal)); }
      catch (cause) { if (cause instanceof PicPatchSdkError) throw cause; throw new PicPatchSdkError('ENGINE_IO', 'Could not inspect the native engine.', { cause }); }
    });
  });
}
/** Explicit acquisition. Pass the returned nativeExecutable to an editor or profile. No implicit install. */
export function installNativeEngine(settings: NativeEngineSettings = {}, options: CallOptions = {}): Promise<NativeEngineInstallation> {
  return withDiagnostics('installNativeEngine', options, call => install(withSettings(settings, ['profile', 'engineDirectory'], call)));
}
async function install(options: NativeEngineOptions): Promise<NativeEngineInstallation> {
  const directory = root(options);
  const pinned = requireRelease();
  let completed: NativeEngineInstallation | undefined;
  return withDeadline(options.signal, timeBudget(options.timeoutMs, 600_000), 'Native engine installation timed out.', async signal => {
    operationStage(options, 'checking', 'Checking the native engine.');
    const existing = await inspect(directory, signal);
    if (existing.status === 'ready') return { ...existing, origin: 'reused' as const };
    // Unknown/incomplete contents are preserved, not repaired in place.
    try { await lstat(installation(directory, pinned)); throw new PicPatchSdkError('ENGINE_INCOMPATIBLE', 'Existing native installation is incomplete or incompatible; it was preserved.'); }
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
      await downloadFile(pinned.url, archive, pinned.bytes, signal, fetch, 'ENGINE_IO');
      const file = await open(archive, 'r');
      try {
        const hash = createHash('sha256'); const buffer = Buffer.alloc(1024 * 1024); let position = 0;
        for (;;) {
          checkSignal(signal);
          const { bytesRead } = await file.read(buffer, 0, buffer.length, position);
          if (!bytesRead) break;
          position += bytesRead; hash.update(buffer.subarray(0, bytesRead));
        }
        if (hash.digest('hex') !== pinned.sha256) throw new PicPatchSdkError('ENGINE_INCOMPATIBLE', 'Native archive integrity did not match the pinned release.');
      } finally { await file.close(); }
      // Only the independently authenticated, fixed archive is extracted, and only these flat entries.
      await runCommand(archiveTool(), ['-xf', archive, '-C', extracted, ...Object.keys(pinned.files)], staging, env, signal, 60_000);
      for (const [name, bytes] of Object.entries(pinned.files)) {
        const path = join(extracted, name); const info = await lstat(path);
        if (!info.isFile() || info.size !== bytes) throw new PicPatchSdkError('ENGINE_INCOMPATIBLE', 'Extracted native files did not match the release.');
        await chmod(path, name.endsWith('.txt') ? 0o600 : 0o700);
        await syncFile(path);
      }
      if ((await readdir(extracted)).length !== Object.keys(pinned.files).length) throw new PicPatchSdkError('ENGINE_INCOMPATIBLE', 'Unexpected native archive contents.');
      if (process.platform === 'darwin') {
        for (const name of ['sd-cli', 'libstable-diffusion.dylib']) await runCommand('/usr/bin/lipo', ['-verify_arch', 'arm64', join(extracted, name)], staging, env, signal, 15_000);
        await runCommand('/usr/bin/xattr', ['-cr', extracted], staging, env, signal, 15_000);
      }
      let output: string;
      try { output = await runCommand(join(extracted, pinned.executable), ['--help'], extracted, env, signal, 15_000); }
      catch (cause) {
        if (missingDll(cause)) throw new PicPatchSdkError('DEPENDENCY_MISSING', 'The native engine needs the Microsoft Visual C++ Redistributable (x64).', { cause, subject: 'msvc-runtime' });
        throw cause;
      }
      if (probeCommit(output) !== nativeRevision.slice(0, 7)) throw new PicPatchSdkError('ENGINE_INCOMPATIBLE', 'Native engine probe did not match the pinned release.');
      await syncDirectory(extracted);
      operationStage(options, 'publishing', 'Publishing the verified native engine.');
      checkSignal(signal); publicationAttempted = true;
      try { await publish(extracted, installation(directory, pinned)); }
      catch (cause) {
        if (!['EEXIST', 'ENOTEMPTY', 'EPERM'].includes((cause as NodeJS.ErrnoException).code ?? '')) throw cause;
        const winner = await inspect(directory, signal);
        if (winner.status !== 'ready') throw new PicPatchSdkError('ENGINE_INCOMPATIBLE', 'A conflicting native installation was preserved.');
      }
      await syncDirectory(parent);
      completed = { status: 'ready', code: 'ENGINE_READY', message: 'The native engine is ready.', engineDirectory: directory, nativeExecutable: join(installation(directory, pinned), pinned.executable), revision: nativeRevision, origin: 'installed' };
      await storageCleanup(() => rm(staging, { recursive: true, force: true }));
      return completed;
    } catch (cause) {
      if (completed) { completed.cleanupWarning = { directory: staging, message: 'Native engine is ready; staging cleanup failed.' }; return completed; }
      const error = cause instanceof PicPatchSdkError ? cause : new PicPatchSdkError('ENGINE_IO', 'Native engine installation failed.', { cause });
      if (storageStalled() || publicationAttempted || error.code === 'TERMINATION_FAILED') { error.effect = 'unknown'; error.details.recoveryDirectory = staging; }
      else {
        // The primary failure keeps its code; staging that remains is named in details.
        try { await storageCleanup(() => rm(staging, { recursive: true, force: true })); }
        catch { error.details.recoveryDirectory = staging; }
      }
      throw error;
    }
  }).catch(cause => { if (completed) return completed; if (cause instanceof PicPatchSdkError) throw cause; throw new PicPatchSdkError('ENGINE_IO', 'Could not install the native engine.', { cause }); });
}
/**
 * Moves the verified folder into place. Windows briefly refuses a rename while an antivirus scanner
 * holds a fresh executable open, so a busy refusal is retried within a short bound; a destination
 * that already exists is left for the caller to inspect.
 */
async function publish(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try { await rename(from, to); return; }
    catch (cause) {
      const code = (cause as NodeJS.ErrnoException).code ?? '';
      if (process.platform !== 'win32' || !['EPERM', 'EBUSY', 'EACCES'].includes(code) || attempt >= 9) throw cause;
      try { await lstat(to); throw cause; } catch (probe) { if (probe === cause) throw cause; }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
}
