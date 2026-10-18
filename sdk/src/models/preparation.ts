import { storageCleanup, storageRecovery, storageStalled } from '../storage.ts';
import type { ModelRegistration } from './opening.ts';
import { validateProfile, type PicPatchProfile } from '../profile.ts';
import { attachMfluxLoras, validateMfluxLoras } from '../backends/mflux/loras.ts';
import { prepareNativeModel } from '../backends/stable-diffusion-cpp/preparation.ts';
import { withDiagnostics } from '../diagnostics.ts';
import { chmod, lstat, mkdir, mkdtemp, open, rename, rm } from '../storage.ts';
import { dirname, join } from 'node:path';
import { PicPatchSdkError } from '../errors.ts';
import { absolutePath, checkSignal, emitProgress, timeBudget, validateOperation, withDeadline } from '../operations.ts';
import { resolveStoragePaths, type StorageOptions } from '../paths.ts';
import type { LocalEditingModel } from '../contracts.generated.ts';
import { catalogModel, type CatalogModel } from './catalog.ts';
import { prepareExternalModel } from './external.ts';
import { downloadFile } from './download.ts';
import { validateModelManifest, verifyModelOperation as verifyModel } from './verification.ts';
import type { ModelOperationOptions } from './types.ts';

export interface PrepareModelOptions extends ModelOperationOptions {
  profile?: PicPatchProfile;
  /** Use an external bundle in place, with no copying or acquisition. */
  directory?: string;
  /** Native checkpoint and optional VAE paths relative to directory. */
  checkpoint?: string;
  vae?: string;
  photoMaker?: string;
  ipAdapter?: string;
  clipVision?: string;
  /** Local structural conditioning asset, relative to directory. */
  controlNet?: import('../contracts.generated.ts').LocalControlNet;
  /** Local LoRAs, relative to directory. Scale defaults to one. */
  loras?: import('../contracts.generated.ts').LocalLora[];
  /** Explicit opt-in for a missing catalog bundle; false by default. */
  download?: boolean;
  storage?: StorageOptions;
}
export interface PreparedModel extends ModelRegistration {
  model: LocalEditingModel;
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
async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

/** Explicit preparation only. Reuses and verifies files; never repairs existing bundles. */
async function prepareModelOperation(id: string, options: PrepareModelOptions = {}): Promise<PreparedModel> {
  validateOperation(options, ['profile', 'directory', 'download', 'storage', 'checkpoint', 'vae', 'photoMaker', 'ipAdapter', 'clipVision', 'loras', 'controlNet']);
  if (options.storage !== undefined) resolveStoragePaths(options.storage);
  const entry = catalogModel(id);
  if (options.profile !== undefined) {
    const { profile: input, ...explicit } = options;
    const profile = validateProfile(input);
    const modelsDirectory = explicit.storage?.modelsDirectory ?? profile.modelsDirectory;
    options = entry.acquisition === 'pinned'
      ? { ...explicit, storage: { ...explicit.storage, ...(modelsDirectory === undefined ? {} : { modelsDirectory }) } }
      : explicit;
  }
  if (entry.runtime.name === 'stable-diffusion.cpp') {
    // Resource defaults do not redirect a caller-owned native bundle.
    const { storage: _storage, ...nativeOptions } = options;
    return prepareNativeModel(entry.variant, nativeOptions);
  }
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
  validateOperation(options, ['timeoutMs', 'directory', 'download', 'storage']);
  if (options.download !== undefined && typeof options.download !== 'boolean') throw new PicPatchSdkError('INVALID_REQUEST', 'download must be a boolean.');
  if (options.directory !== undefined) absolutePath(options.directory);
  if (options.directory !== undefined && options.download) throw new PicPatchSdkError('INVALID_REQUEST', 'External bundles cannot be downloaded or repaired in place.');
  const paths = resolveStoragePaths(options.storage);
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
        if (result.status !== 'matches-manifest') throw new PicPatchSdkError('MODEL_IO', 'Model files do not match the catalog. Existing files were preserved; choose a complete bundle or a new cache location.');
      };
      const result = (origin: PreparedModel['origin']): PreparedModel => ({ version: 1, model: { variant: entry.variant, directory, manifest: structuredClone(entry.manifest) }, origin, integrity: 'matches-manifest' });
      if (await exists(directory)) { await verified(directory); return result(options.directory ? 'external' : 'cache'); }
      checkSignal(signal);
      if (options.directory || !options.download) throw new PicPatchSdkError('MODEL_IO', 'Model bundle is missing. Supply a local directory or explicitly enable download.');
      await privateDirectory(paths.modelsDirectory);
      const parent = dirname(directory);
      if (await exists(parent) && (await lstat(parent)).isSymbolicLink()) throw new PicPatchSdkError('MODEL_IO', 'A managed model directory cannot be a symbolic link.');
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
          const file = await open(path, 'r');
          try { await file.sync(); } finally { await file.close(); }
        }
        await verified(staging);
        // Sync nested directories before making the complete bundle visible.
        const directories = new Set(entry.manifest.components.map(c => dirname(join(staging, c.path))));
        for (const path of directories) await syncDirectory(path);
        await syncDirectory(staging);
        checkSignal(signal);
        try { await rename(staging, directory); }
        catch (cause) {
          if (!['EEXIST', 'ENOTEMPTY'].includes((cause as NodeJS.ErrnoException).code ?? '')) throw new PicPatchSdkError('MODEL_IO', 'Model publication could not be confirmed.', { cause, effect: 'unknown', subject: directory });
          await verified(directory); // A concurrent complete winner is reusable, never replaced.
          return result('cache');
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
          else { const error = new PicPatchSdkError('CLEANUP_FAILED', 'Model preparation staging could not be removed.', { cause: failure ?? cause }); error.details.recoveryDirectory = staging; error.effect = 'unknown'; throw error; }
        }
      }
    });
  } catch (cause) {
    if (committed) return committed; // Publication wins cancellation races.
    if (cause instanceof PicPatchSdkError) throw cause;
    throw new PicPatchSdkError('MODEL_IO', 'Could not prepare the model bundle.', { cause });
  }
}

export function prepareModel(id: string, options: PrepareModelOptions = {}): Promise<import('../logging.ts').Logged<PreparedModel>> {
  return withDiagnostics('prepareModel', options, operation => prepareModelOperation(id, operation));
}
