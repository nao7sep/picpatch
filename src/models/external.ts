import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, readdir, realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { PicPatchCancelledError, PicPatchRuntimeError, PicPatchUsageError } from '../errors.ts';
import { absolutePath, checkSignal, emitProgress, timeBudget, validateOperation, withDeadline } from '../operations.ts';
import type { ModelComponent, ModelManifest } from '../contracts.generated.ts';
import type { PrepareModelOptions, PreparedModel } from './preparation.ts';
import { modelDefinition, type ExternalModel } from './variants.ts';
import { validateModelManifest, verifyModel } from './verification.ts';

/** Fingerprint a caller-selected MFLUX bundle. This records bytes, not upstream authenticity. */
export async function prepareExternalModel(entry: Pick<ExternalModel, 'id' | 'variant'>, options: PrepareModelOptions): Promise<PreparedModel> {
  validateOperation(options, ['timeoutMs', 'directory', 'download', 'storage']);
  if (options.download !== undefined && typeof options.download !== 'boolean') throw new PicPatchUsageError('INVALID_REQUEST', 'download must be a boolean.');
  if (!options.directory || options.download) throw new PicPatchUsageError('INVALID_REQUEST', 'This variant requires a local directory and does not offer downloads.');
  absolutePath(options.directory);
  const directory = options.directory;
  const definition = modelDefinition(entry.variant);
  return withDeadline(options.signal, timeBudget(options.timeoutMs, 3_600_000), 'Model preparation timed out.', async signal => {
    const operation = { ...options, signal };
    try {
      const root = await realpath(directory);
      const components: ModelComponent[] = [];
      const visit = async (relative: string): Promise<void> => {
        checkSignal(signal);
        const path = join(root, relative);
        if (await realpath(path) !== path) throw new PicPatchRuntimeError('MODEL_IO', 'Model component directories must not be symbolic links.');
        // Do not traverse directory links. File links are allowed for HF cache blobs.
        for (const item of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
          checkSignal(signal);
          const name = `${relative}/${item.name}`;
          if (item.isDirectory()) { await visit(name); continue; }
          const file = await open(join(root, name), constants.O_RDONLY | constants.O_NONBLOCK);
          try {
            const before = await file.stat({ bigint: true });
            if (!before.isFile() || before.size === 0n || before.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new PicPatchRuntimeError('MODEL_IO', 'The bundle contains an empty or unsupported component.');
            emitProgress(operation, { type: 'progress', verb: 'prepareModel', stage: 'verifying', message: 'Fingerprinting a local model component.', path: name });
            const hash = createHash('sha256');
            const buffer = Buffer.allocUnsafe(64 * 1024);
            let position = 0;
            while (position <= Number(before.size)) {
              checkSignal(signal);
              const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, Number(before.size) + 1 - position), position);
              if (!bytesRead) break;
              hash.update(buffer.subarray(0, bytesRead)); position += bytesRead;
            }
            const after = await file.stat({ bigint: true });
            const current = await stat(join(root, name), { bigint: true });
            if (position !== Number(before.size) || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || before.ino !== current.ino || before.dev !== current.dev) throw new PicPatchRuntimeError('MODEL_IO', 'A model component changed during preparation.');
            const role = name.endsWith('.safetensors') ? 'weights' : name.endsWith('.index.json') ? 'shard-index' : (relative.startsWith('tokenizer') || relative === 'processor') ? 'tokenizer' : 'configuration';
            components.push({ path: name, role, bytes: position, sha256: hash.digest('hex') });
          } finally { await file.close(); }
        }
      };
      for (const part of definition.requiredDirectories) {
        if (await realpath(join(root, part)) !== join(root, part)) throw new PicPatchRuntimeError('MODEL_IO', 'Model component directories must not be symbolic links.');
        await visit(part);
        const files = components.filter(c => c.path.startsWith(`${part}/`));
        if (!files.length || (!part.startsWith('tokenizer') && part !== 'processor' && !files.some(c => c.role === 'weights'))) throw new PicPatchRuntimeError('MODEL_IO', 'The selected variant requires a complete MFLUX bundle.');
      }
      for (const required of definition.requiredFiles ?? []) {
        if (!components.some(component => component.path === required)) throw new PicPatchRuntimeError('MODEL_IO', 'The selected variant requires complete component and processor configuration files.');
      }
      const revision = createHash('sha256').update(JSON.stringify({ variant: entry.variant, components })).digest('hex');
      const manifest: ModelManifest = validateModelManifest({ version: 1, model: entry.id, source: { repository: 'local', revision }, components });
      // Reuse shard-index, containment and snapshot validation before accepting the bundle.
      const verified = await verifyModel(directory, manifest, { signal, timeoutMs: timeBudget(options.timeoutMs, 3_600_000), onProgress: event => emitProgress(operation, event) });
      if (verified.status !== 'matches-manifest') throw new PicPatchRuntimeError('MODEL_IO', 'The local bundle changed or has invalid shard references.');
      return { model: { variant: entry.variant, directory, manifest }, origin: 'external', integrity: 'locally-fingerprinted' };
    } catch (cause) {
      checkSignal(signal);
      if (cause instanceof PicPatchUsageError || cause instanceof PicPatchRuntimeError || cause instanceof PicPatchCancelledError) throw cause;
      throw new PicPatchRuntimeError('MODEL_IO', 'Could not prepare the local MFLUX bundle.', { cause });
    }
  });
}
