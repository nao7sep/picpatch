import { storageCleanup, storageRecovery, storageStalled } from '../storage.ts';
import type { ModelRegistration } from './opening.ts';
import { checkProfile, type PicPatchProfile } from '../profile.ts';
import { attachMfluxLoras, validateMfluxLoras } from '../backends/mflux/loras.ts';
import { prepareNativeModel } from '../backends/stable-diffusion-cpp/preparation.ts';
import { withDiagnostics } from '../diagnostics.ts';
import { chmod, lstat, mkdir, mkdtemp, open, rename, rm } from '../storage.ts';
import { dirname, join } from 'node:path';
import { PicPatchSdkError } from '../errors.ts';
import { absolutePath, checkSignal, emitProgress, timeBudget, validateOperation, withDeadline } from '../operations.ts';
import { resolveStoragePaths } from '../paths.ts';
import type { LocalModel } from '../contracts.generated.ts';
import { catalogModel, type CatalogModel } from './catalog.ts';
import { prepareExternalModel } from './external.ts';
import { downloadFile } from '../runtime/download.ts';
import { validateModelManifest, verifyModelOperation as verifyModel } from './verification.ts';
import type { ModelOperationOptions } from './types.ts';
import { syncDirectory, syncFile } from '../platform.ts';

export interface PrepareModelOptions extends ModelOperationOptions {
  profile?: PicPatchProfile;
  /** Use an external bundle in place, with no copying or acquisition. */
  directory?: string;
  /** Native checkpoint and optional VAE paths relative to directory. */
  checkpoint?: string;
  vae?: string;
  /** Separate native text encoders, relative to directory. */
  clipL?: string;
  clipG?: string;
  t5?: string;
  photoMaker?: string;
  ipAdapter?: string;
  clipVision?: string;
  /** Local structural conditioning asset, relative to directory. */
  controlNet?: import('../contracts.generated.ts').LocalControlNet;
  /** Local LoRAs, relative to directory. Scale defaults to one. */
  loras?: import('../contracts.generated.ts').LocalLora[];
  /** Explicit opt-in for a missing catalog bundle; false by default. */
  download?: boolean;
  modelsDirectory?: string;
}
export interface PreparedModel extends ModelRegistration {
  model: LocalModel;
  origin: 'external' | 'cache' | 'download';
  integrity: 'matches-manifest' | 'locally-fingerprinted';
  cleanupWarning?: { directory: string; message: string };
}
async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (cause) { if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return false; throw cause; }
}
async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') await chmod(path, 0o700);
}

/** Explicit preparation only. Reuses and verifies files; never repairs existing bundles. */
async function prepareModelOperation(id: string, options: PrepareModelOptions = {}): Promise<PreparedModel> {
  validateOperation(options, ['profile', 'directory', 'download', 'modelsDirectory', 'checkpoint', 'vae', 'photoMaker', 'ipAdapter', 'clipVision', 'clipL', 'clipG', 't5', 'loras', 'controlNet']);
  if (options.modelsDirectory !== undefined) absolutePath(options.modelsDirectory);
  const entry = catalogModel(id);
  if (options.profile !== undefined) {
    const { profile: input, ...explicit } = options;
    const profile = checkProfile(input);
    const modelsDirectory = explicit.modelsDirectory ?? profile.modelsDirectory;
    options = entry.acquisition === 'pinned'
      ? { ...explicit, ...(modelsDirectory === undefined ? {} : { modelsDirectory }) }
      : explicit;
  }
  if (entry.runtime.name === 'stable-diffusion.cpp') {
    // Resource defaults do not redirect a caller-owned native bundle.
    const { modelsDirectory: _modelsDirectory, ...nativeOptions } = options;
    return prepareNativeModel(entry.variant, nativeOptions);
  }
  if (entry.runtime.name !== 'mflux' && options.loras !== undefined) throw new PicPatchSdkError('UNSUPPORTED_CAPABILITY', 'This runtime uses fixed trained components; additional LoRAs are unsupported.');
  if (options.loras !== undefined) {
    validateMfluxLoras(options.loras);
    const loras = structuredClone(options.loras);
    const { loras: _selected, ...baseOptions } = options;
    return withDeadline(options.signal, timeBudget(options.timeoutMs, 3_600_000), 'Model and LoRA preparation timed out.', async signal => {
      const operation = { ...baseOptions, signal };
      const prepared = entry.acquisition === 'pinned' ? await prepareCatalogModel(entry, operation) : await prepareExternalModel(entry, operation);
      try { return await attachMfluxLoras(prepared, loras, operation); }
      catch (cause) {
        checkSignal(signal);
        if (cause instanceof PicPatchSdkError) throw cause;
        throw new PicPatchSdkError('MODEL_IO', 'Could not prepare local LoRA weights.', { cause });
      }
    });
  }
  return entry.acquisition === 'pinned' ? prepareCatalogModel(entry, options) : prepareExternalModel(entry, options);
}

/** Internal catalog/transport boundary used with tiny fixture bundles in acquisition tests. */
export async function prepareCatalogModel(entry: CatalogModel, options: PrepareModelOptions, fetcher: typeof fetch = fetch): Promise<PreparedModel> {
  entry = { ...entry, manifest: validateModelManifest(entry.manifest) };
  validateOperation(options, ['timeoutMs', 'directory', 'download', 'modelsDirectory']);
  if (options.download !== undefined && typeof options.download !== 'boolean') throw new PicPatchSdkError('INVALID_REQUEST', 'download must be a boolean.');
  if (options.directory !== undefined) absolutePath(options.directory);
  if (options.directory !== undefined && options.download) throw new PicPatchSdkError('INVALID_REQUEST', 'External bundles cannot be downloaded or repaired in place.');
  const paths = resolveStoragePaths(options.modelsDirectory === undefined ? {} : { modelsDirectory: options.modelsDirectory });
  const budget = timeBudget(options.timeoutMs, 3_600_000);
  // Catalog identity, not caller-controlled filesystem syntax, determines the cache key.
  if (!/^[a-z0-9-]+$/.test(entry.id)) throw new PicPatchSdkError('INVALID_REQUEST', 'Invalid catalog ID.');
  const directory = options.directory ?? join(paths.modelsDirectory, entry.id, entry.manifest.source.revision);
  let committed: PreparedModel | undefined;
  try {
    return await withDeadline(options.signal, budget, 'Model preparation timed out.', async signal => {
      const operation = { ...options, signal };
      const verified = async (path: string) => {
        const result = await verifyModel(path, entry.manifest, { signal, timeoutMs: budget, onProgress: event => emitProgress(operation, event) });
        if (result.status !== 'matches-manifest') throw new PicPatchSdkError('MODEL_MISMATCH', 'Model files do not match the catalog. Existing files were preserved; choose a complete bundle or a new cache location.');
      };
      const result = (origin: PreparedModel['origin']): PreparedModel => ({ version: 1, model: { variant: entry.variant, directory, manifest: structuredClone(entry.manifest) }, origin, integrity: 'matches-manifest' });
      if (await exists(directory)) { await verified(directory); return result(options.directory ? 'external' : 'cache'); }
      checkSignal(signal);
      if (options.directory || !options.download) throw new PicPatchSdkError('MODEL_MISSING', 'Model bundle is missing. Supply a local directory or explicitly enable download.');
      await privateDirectory(paths.modelsDirectory);
      const parent = dirname(directory);
      if (await exists(parent) && (await lstat(parent)).isSymbolicLink()) throw new PicPatchSdkError('MODEL_LINK_REFUSED', 'A managed model directory cannot be a symbolic link.', { subject: parent });
      await privateDirectory(parent);
      checkSignal(signal);
      const staging = await mkdtemp(join(parent, '.prepare-'));
      storageRecovery(staging);
      let failure: unknown;
      try {
        for (const component of entry.manifest.components) {
          emitProgress(operation, { type: 'progress', verb: 'prepareModel', stage: 'downloading', completed: entry.manifest.components.indexOf(component), total: entry.manifest.components.length, message: 'Downloading a pinned model component.', path: component.path });
          const path = join(staging, component.path);
          await mkdir(dirname(path), { recursive: true, mode: 0o700 });
          const source = entry.manifest.source;
          const url = `https://huggingface.co/${source.repository}/resolve/${source.revision}/${component.path.split('/').map(encodeURIComponent).join('/')}`;
          await downloadFile(url, path, component.bytes, signal, fetcher);
          await syncFile(path);
        }
        await verified(staging);
        // Sync nested directories before making the complete bundle visible.
        const directories = new Set(entry.manifest.components.map(c => dirname(join(staging, c.path))));
        for (const path of directories) await syncDirectory(path);
        await syncDirectory(staging);
        checkSignal(signal);
        try { await rename(staging, directory); }
        catch (cause) {
          // Windows refuses a rename onto an existing directory with EPERM rather than EEXIST/ENOTEMPTY.
          const conflict = ['EEXIST', 'ENOTEMPTY'].includes((cause as NodeJS.ErrnoException).code ?? '') || (process.platform === 'win32' && (cause as NodeJS.ErrnoException).code === 'EPERM' && await exists(directory));
          if (!conflict) throw new PicPatchSdkError('MODEL_IO', 'Model publication could not be confirmed.', { cause, effect: 'unknown', subject: directory });
          await verified(directory); // A concurrent complete winner is reusable, never replaced.
          committed = result('cache');
          return committed;
        }
        committed = result('download');
        try { await syncDirectory(parent); }
        catch { committed.cleanupWarning = { directory, message: 'Model is published, but directory durability could not be confirmed.' }; }
        return committed;
      } catch (cause) { failure = cause; throw cause; }
      finally {
        try { if (!storageStalled()) await storageCleanup(() => rm(staging, { recursive: true, force: true })); }
        catch (cause) {
          if (committed) committed.cleanupWarning = { directory: staging, message: 'Model is prepared; staging cleanup failed.' };
          // The primary failure keeps its code; staging that remains is named in details.
          else if (failure instanceof PicPatchSdkError) failure.details.recoveryDirectory = staging;
          else throw new PicPatchSdkError('MODEL_IO', 'Could not prepare the model bundle.', { cause: failure ?? cause, details: { recoveryDirectory: staging } });
        }
      }
    });
  } catch (cause) {
    if (committed) return committed; // Publication wins cancellation races.
    if (cause instanceof PicPatchSdkError) throw cause;
    throw new PicPatchSdkError('MODEL_IO', 'Could not prepare the model bundle.', { cause });
  }
}

export function prepareModel(id: string, options: PrepareModelOptions = {}): Promise<PreparedModel> {
  return withDiagnostics('prepareModel', options, operation => prepareModelOperation(id, operation));
}
