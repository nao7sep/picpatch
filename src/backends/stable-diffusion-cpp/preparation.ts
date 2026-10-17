import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { absolutePath, checkSignal, emitProgress, timeBudget, validateOperation, withDeadline } from '../../operations.ts';
import { PicPatchCancelledError, PicPatchRuntimeError, PicPatchUsageError } from '../../errors.ts';
import { validateLocalEditingModel, validateModelManifest, verifyModel } from '../../models/verification.ts';
import type { LocalEditingModel, ModelComponent } from '../../contracts.generated.ts';
import type { PrepareModelOptions, PreparedModel } from '../../models/preparation.ts';

/** Explicit caller file selection; preparation proves byte identity, not architecture. */
export async function prepareNativeModel(variant: LocalEditingModel['variant'], options: PrepareModelOptions): Promise<PreparedModel> {
  validateOperation(options, ['timeoutMs', 'directory', 'download', 'checkpoint', 'vae']);
  if (!options.directory || !options.checkpoint || (options.download !== undefined && options.download !== false)) throw new PicPatchUsageError('INVALID_REQUEST', 'Supply a local directory and relative checkpoint; native variants have no downloads.');
  absolutePath(options.directory);
  const directory = options.directory;
  const selected = [options.checkpoint, ...(options.vae === undefined ? [] : [options.vae])];
  if (new Set(selected).size !== selected.length) throw new PicPatchUsageError('INVALID_REQUEST', 'Checkpoint and VAE must be distinct files.');
  for (const path of selected) {
    if (typeof path !== 'string' || !['.safetensors', '.gguf'].includes(extname(path).toLowerCase())) throw new PicPatchUsageError('INVALID_REQUEST', 'Native weights must be safetensors or GGUF files.');
  }
  // Reuse manifest path rules before opening any selected file.
  validateModelManifest({ version: 1, model: variant, source: { repository: 'local', revision: '0'.repeat(64) },
    components: selected.map(path => ({ path, role: 'weights', bytes: 1, sha256: '0'.repeat(64) })) });
  return withDeadline(options.signal, timeBudget(options.timeoutMs, 3_600_000), 'Model preparation timed out.', async signal => {
    try {
      const root = await realpath(directory);
      const components: ModelComponent[] = [];
      for (const path of selected) {
        checkSignal(signal);
        const target = join(root, path);
        if (await realpath(dirname(target)) !== dirname(target)) throw new PicPatchRuntimeError('MODEL_IO', 'Native component directories must not be symbolic links.');
        const file = await open(target, constants.O_RDONLY | constants.O_NONBLOCK);
        try {
          const before = await file.stat({ bigint: true });
          if (!before.isFile() || before.size <= 0n || before.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new PicPatchRuntimeError('MODEL_IO', 'Select nonempty regular weight files.');
          emitProgress({ ...options, signal }, { type: 'progress', verb: 'prepareModel', stage: 'verifying', message: 'Fingerprinting native model weights.', path });
          const hash = createHash('sha256'); const buffer = Buffer.allocUnsafe(64 * 1024);
          let position = 0;
          while (position <= Number(before.size)) {
            checkSignal(signal);
            const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, Number(before.size) + 1 - position), position);
            if (!bytesRead) break;
            hash.update(buffer.subarray(0, bytesRead)); position += bytesRead;
          }
          const after = await file.stat({ bigint: true }); const current = await stat(target, { bigint: true });
          if (position !== Number(before.size) || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || before.ino !== current.ino || before.dev !== current.dev) throw new PicPatchRuntimeError('MODEL_IO', 'Native weights changed during preparation.');
          components.push({ path, role: 'weights', bytes: position, sha256: hash.digest('hex') });
        } finally { await file.close(); }
      }
      const revision = createHash('sha256').update(JSON.stringify({ variant, components })).digest('hex');
      const manifest = validateModelManifest({ version: 1, model: variant, source: { repository: 'local', revision }, components });
      const verification = await verifyModel(directory, manifest, { signal, timeoutMs: timeBudget(options.timeoutMs, 3_600_000) });
      if (verification.status !== 'matches-manifest') throw new PicPatchRuntimeError('MODEL_IO', 'Native weights changed or escape the selected directory.');
      return { model: validateLocalEditingModel({ variant, directory, manifest, checkpoint: options.checkpoint, ...(options.vae ? { vae: options.vae } : {}) }), origin: 'external', integrity: 'locally-fingerprinted' };
    } catch (cause) {
      checkSignal(signal);
      if (cause instanceof PicPatchUsageError || cause instanceof PicPatchRuntimeError || cause instanceof PicPatchCancelledError) throw cause;
      throw new PicPatchRuntimeError('MODEL_IO', 'Could not prepare native model files.', { cause });
    }
  });
}
