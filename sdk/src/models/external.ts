import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, readdir, realpath, stat } from '../storage.ts';
import type { BigIntStats } from 'node:fs';
import { join } from 'node:path';
import { PicPatchSdkError } from '../errors.ts';
import { absolutePath, checkSignal, emitProgress, validateOperation } from '../operations.ts';
import type { ModelComponent, ModelManifest } from '../contracts.generated.ts';
import type { PrepareModelOptions, PreparedModel } from './preparation.ts';
import { modelDefinition, type ExternalModel } from './variants.ts';
import { shardIndexValid, validateModelManifest } from './verification.ts';

/** Fingerprint a caller-selected runtime bundle. This records bytes, not upstream authenticity. */
export async function prepareExternalModel(entry: Pick<ExternalModel, 'id' | 'variant'>, options: PrepareModelOptions): Promise<PreparedModel> {
  validateOperation(options, ['timeoutMs', 'directory', 'download', 'modelsDirectory']);
  if (options.download !== undefined && typeof options.download !== 'boolean') throw new PicPatchSdkError('INVALID_REQUEST', 'download must be a boolean.');
  if (!options.directory || options.download) throw new PicPatchSdkError('INVALID_REQUEST', 'This variant requires a local directory and does not offer downloads.');
  absolutePath(options.directory);
  const directory = options.directory;
  const definition = modelDefinition(entry.variant);
  const signal = options.signal;
  const operation = options;
  checkSignal(signal);
  try {
    const root = await realpath(directory);
    const components: ModelComponent[] = [];
    const snapshots = new Map<string, BigIntStats>();
    const visit = async (relative: string, rootFiles?: Set<string>): Promise<void> => {
      checkSignal(signal);
      const path = join(root, relative);
      if (await realpath(path) !== path) throw new PicPatchSdkError('MODEL_LINK_REFUSED', 'Model component directories must not be symbolic links.', { subject: path });
      // Do not traverse directory links. File links are allowed for HF cache blobs.
      for (const item of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        checkSignal(signal);
        if (rootFiles && !rootFiles.has(item.name)) continue;
        const name = relative ? `${relative}/${item.name}` : item.name;
        if (item.isDirectory()) { await visit(name); continue; }
        const file = await open(join(root, name), constants.O_RDONLY | constants.O_NONBLOCK);
        try {
          const before = await file.stat({ bigint: true });
          if (!before.isFile() || before.size === 0n || before.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new PicPatchSdkError('MODEL_COMPONENT_INVALID', 'The bundle contains an empty or unsupported component.', { subject: join(root, name) });
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
          if (position !== Number(before.size) || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || before.ino !== current.ino || before.dev !== current.dev) throw new PicPatchSdkError('MODEL_CHANGED', 'A model component changed during preparation.', { subject: join(root, name) });
          snapshots.set(name, after);
          const role = (name.endsWith('.safetensors') || (entry.variant === 'flux1-dreamo-v1.1' && name === 'preprocessing/BEN2_Base.pth')) ? 'weights' : name.endsWith('.index.json') ? 'shard-index' : (relative.startsWith('tokenizer') || relative === 'processor') ? 'tokenizer' : 'configuration';
          components.push({ path: name, role, bytes: position, sha256: hash.digest('hex') });
        } finally { await file.close(); }
      }
    };
    for (const part of definition.requiredDirectories) {
      let resolved: string;
      try { resolved = await realpath(join(root, part)); }
      catch (cause) {
        if (['ENOENT', 'ENOTDIR'].includes((cause as NodeJS.ErrnoException).code ?? '')) throw new PicPatchSdkError('MODEL_BUNDLE_INCOMPLETE', 'The selected variant requires a complete model bundle.', { cause, subject: join(root, part) });
        throw cause;
      }
      if (resolved !== join(root, part)) throw new PicPatchSdkError('MODEL_LINK_REFUSED', 'Model component directories must not be symbolic links.', { subject: join(root, part) });
      await visit(part);
      const files = components.filter(c => c.path.startsWith(`${part}/`));
      if (!files.length || (!part.startsWith('tokenizer') && !['processor', 'scheduler'].includes(part) && !files.some(c => c.role === 'weights'))) throw new PicPatchSdkError('MODEL_BUNDLE_INCOMPLETE', 'The selected variant requires a complete model bundle.', { subject: join(root, part) });
    }
    if (entry.variant === 'flux1-dreamo-v1.1') {
      for (const part of ['transformer', 'vae', 'text_encoder', 'text_encoder_2']) {
        if (!components.some(component => component.path.startsWith(`base/${part}/`) && component.role === 'weights')) throw new PicPatchSdkError('MODEL_BUNDLE_INCOMPLETE', 'DreamO requires complete local base-model component weights.', { subject: root });
      }
    }
    const rootFiles = new Set((definition.requiredFiles ?? []).filter(path => !path.includes('/')));
    if (rootFiles.size) await visit('', rootFiles);
    for (const required of definition.requiredFiles ?? []) {
      if (!components.some(component => component.path === required)) throw new PicPatchSdkError('MODEL_BUNDLE_INCOMPLETE', 'The selected variant requires complete component and processor configuration files.', { subject: root });
    }
    const revision = createHash('sha256').update(JSON.stringify({ variant: entry.variant, components })).digest('hex');
    const manifest: ModelManifest = validateModelManifest({ model: entry.id, source: { repository: 'local', revision }, components });
    // The fingerprinting read already checked each file's identity and mutation, and the directory walk
    // refused linked folders. Check the shard indexes and recheck every file, rather than reading all weights twice.
    for (const component of components) {
      checkSignal(signal);
      if (component.role === 'shard-index' && !await shardIndexValid(join(root, component.path), component, manifest, signal)) throw new PicPatchSdkError('MODEL_MISMATCH', 'A shard index names weights the bundle does not contain.', { subject: join(root, component.path) });
    }
    if (await realpath(directory) !== root) throw new PicPatchSdkError('MODEL_CHANGED', 'Model directory changed during preparation.', { subject: directory });
    for (const [name, before] of snapshots) {
      checkSignal(signal);
      const after = await stat(join(root, name), { bigint: true });
      if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw new PicPatchSdkError('MODEL_CHANGED', 'A model component changed during preparation.', { subject: join(root, name) });
    }
    emitProgress(operation, { stage: 'verifying', completed: components.length, total: components.length });
    return { model: { variant: entry.variant, directory, manifest }, origin: 'external', integrity: 'locally-fingerprinted' };
  } catch (cause) {
    checkSignal(signal);
    if (cause instanceof PicPatchSdkError) throw cause;
    throw new PicPatchSdkError('MODEL_IO', 'Could not prepare the local model bundle.', { cause });
  }
}
