import { inspectNativeAssets } from './assets.ts';
import type { BigIntStats } from 'node:fs';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath, stat } from '../../storage.ts';
import { dirname, extname, join } from 'node:path';
import { absolutePath, checkSignal, emitProgress, timeBudget, validateOperation, withDeadline } from '../../operations.ts';
import { PicPatchSdkError } from '../../errors.ts';
import { validateLocalEditingModel, validateModelManifest } from '../../models/verification.ts';
import type { LocalEditingModel, ModelComponent } from '../../contracts.generated.ts';
import type { PrepareModelOptions, PreparedModel } from '../../models/preparation.ts';

/** Explicit caller selection, byte fingerprints and recognized conditioning metadata; loading remains separate. */
export async function prepareNativeModel(variant: LocalEditingModel['variant'], options: PrepareModelOptions): Promise<PreparedModel> {
  validateOperation(options, ['timeoutMs', 'directory', 'download', 'checkpoint', 'vae', 'photoMaker', 'ipAdapter', 'clipVision', 'loras', 'controlNet']);
  if (!options.directory || !options.checkpoint || (options.download !== undefined && options.download !== false)) throw new PicPatchSdkError('INVALID_REQUEST', 'Supply a local directory and relative checkpoint; native variants have no downloads.');
  absolutePath(options.directory);
  const directory = options.directory;
  if (options.loras !== undefined && (!Array.isArray(options.loras) || options.loras.length === 0)) throw new PicPatchSdkError('INVALID_REQUEST', 'Supply a nonempty LoRA array.');
  const assets = { ...(options.controlNet !== undefined ? { controlNet: options.controlNet } : {}), ...(options.loras !== undefined ? { loras: options.loras } : {}), checkpoint: options.checkpoint, ...(options.vae ? { vae: options.vae } : {}), ...(options.photoMaker ? { photoMaker: options.photoMaker } : {}), ...(options.ipAdapter ? { ipAdapter: options.ipAdapter } : {}), ...(options.clipVision ? { clipVision: options.clipVision } : {}) };
  const selected = [options.checkpoint, ...(options.controlNet !== undefined ? [options.controlNet?.path] : []), ...(options.loras ?? []).map(lora => lora?.path), ...[options.vae, options.photoMaker, options.ipAdapter, options.clipVision].filter(value => value !== undefined)];
  if (new Set(selected).size !== selected.length) throw new PicPatchSdkError('INVALID_REQUEST', 'Selected native assets must be distinct files.');
  for (const path of selected) {
    if (typeof path !== 'string' || !['.safetensors', '.gguf'].includes(extname(path).toLowerCase())) throw new PicPatchSdkError('INVALID_REQUEST', 'Native weights must be safetensors or GGUF files.');
  }
  // Reuse manifest path rules before opening any selected file.
  validateModelManifest({ version: 1, model: variant, source: { repository: 'local', revision: '0'.repeat(64) },
    components: selected.map(path => ({ path, role: 'weights', bytes: 1, sha256: '0'.repeat(64) })) });
  return withDeadline(options.signal, timeBudget(options.timeoutMs, 3_600_000), 'Model preparation timed out.', async signal => {
    try {
      const root = await realpath(directory);
      const components: ModelComponent[] = [];
      const snapshots = new Map<string, BigIntStats>();
      const provisional = validateLocalEditingModel({ variant, directory: root, ...assets, manifest: { version: 1, model: variant, source: { repository: 'local', revision: '0'.repeat(64) }, components: selected.map(path => ({ path, role: 'weights', bytes: 1, sha256: '0'.repeat(64) })) } });
      // Check compatibility before hashing multi-GB assets; repeat headers under final snapshots below.
      await inspectNativeAssets(provisional, signal);
      for (const path of selected) {
        checkSignal(signal);
        const target = join(root, path);
        if (await realpath(dirname(target)) !== dirname(target)) throw new PicPatchSdkError('MODEL_IO', 'Native component directories must not be symbolic links.');
        const file = await open(target, constants.O_RDONLY | constants.O_NONBLOCK);
        try {
          const before = await file.stat({ bigint: true });
          if (!before.isFile() || before.size <= 0n || before.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new PicPatchSdkError('MODEL_IO', 'Select nonempty regular weight files.');
          emitProgress({ ...options, signal }, { type: 'progress', verb: 'prepareModel', stage: 'verifying', completed: components.length, total: selected.length, message: 'Fingerprinting native model weights.', path });
          const hash = createHash('sha256'); const buffer = Buffer.allocUnsafe(64 * 1024);
          let position = 0;
          while (position <= Number(before.size)) {
            checkSignal(signal);
            const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, Number(before.size) + 1 - position), position);
            if (!bytesRead) break;
            hash.update(buffer.subarray(0, bytesRead)); position += bytesRead;
          }
          const after = await file.stat({ bigint: true }); const current = await stat(target, { bigint: true });
          if (position !== Number(before.size) || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || before.ino !== current.ino || before.dev !== current.dev) throw new PicPatchSdkError('MODEL_IO', 'Native weights changed during preparation.');
          snapshots.set(path, after);
          components.push({ path, role: 'weights', bytes: position, sha256: hash.digest('hex') });
        } finally { await file.close(); }
      }
      const revision = createHash('sha256').update(JSON.stringify({ variant, components })).digest('hex');
      const manifest = validateModelManifest({ version: 1, model: variant, source: { repository: 'local', revision }, components });
      emitProgress({ ...options, signal }, { stage: 'verifying', completed: selected.length, total: selected.length });
      const model = validateLocalEditingModel({ variant, directory, manifest, ...assets });
      await inspectNativeAssets({ ...model, directory: root }, signal);
      // The hashing read already checks file identity and mutation. Recheck every earlier file
      // after callbacks/header inspection, rather than reading all weights a second time.
      if (await realpath(directory) !== root) throw new PicPatchSdkError('MODEL_IO', 'Model directory changed during preparation.');
      for (const [path, before] of snapshots) {
        checkSignal(signal);
        const target = join(root, path);
        if (await realpath(dirname(target)) !== dirname(target)) throw new PicPatchSdkError('MODEL_IO', 'Native component directories changed during preparation.');
        const after = await stat(target, { bigint: true });
        if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw new PicPatchSdkError('MODEL_IO', 'Native weights changed during preparation.');
      }
      return { version: 1, model, origin: 'external', integrity: 'locally-fingerprinted' };
    } catch (cause) {
      checkSignal(signal);
      if (cause instanceof PicPatchSdkError) throw cause;
      throw new PicPatchSdkError('MODEL_IO', 'Could not prepare native model files.', { cause });
    }
  });
}
