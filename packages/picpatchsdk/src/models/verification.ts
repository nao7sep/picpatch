import { isNativeVariant } from '../backends/stable-diffusion-cpp/models.ts';
import { withDiagnostics } from '../diagnostics.ts';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath, stat, type FileHandle } from 'node:fs/promises';
import { dirname, isAbsolute, join, posix, relative, sep } from 'node:path';
import { parser } from 'stream-json';
import { pipeline } from 'node:stream/promises';
import { contractValidator } from '../contracts.ts';
import { PicPatchSdkError } from '../errors.ts';
import { absolutePath, checkSignal, emitProgress, timeBudget, validateOperation, withDeadline } from '../operations.ts';
import type { LocalEditingModel } from '../contracts.generated.ts';
import type { ModelComponent, ModelManifest, ModelOperationOptions, ModelVerificationOptions, ModelVerification, VerifiedComponent } from './types.ts';

const manifestValidator = contractValidator<ModelManifest>('ModelManifest');
/** Portable manifest paths have no expansion, absolute prefix, or traversal segments. */
function componentPath(path: string): boolean {
  return !/[\\:\u0000-\u001f\u007f]/.test(path) && !path.startsWith('/') &&
    path.split('/').every(part => part !== '' && part !== '.' && part !== '..');
}
export function validateModelManifest(input: unknown): ModelManifest {
  if (!manifestValidator(input)) throw new PicPatchSdkError('INVALID_REQUEST', 'Invalid model manifest.');
  const paths = new Set<string>();
  for (const component of input.components) {
    const key = component.path.toLowerCase();
    if (!componentPath(component.path) || paths.has(key)) throw new PicPatchSdkError('INVALID_REQUEST', 'Manifest paths must be unique portable relative file paths.');
    paths.add(key);
  }
  for (const key of paths) {
    const parts = key.split('/'); parts.pop();
    while (parts.length) {
      if (paths.has(parts.join('/'))) throw new PicPatchSdkError('INVALID_REQUEST', 'A manifest file cannot also be a directory.');
      parts.pop();
    }
  }
  if (!input.components.some(component => component.role === 'weights')) throw new PicPatchSdkError('INVALID_REQUEST', 'A model manifest must name its weights.');
  return structuredClone(input);
}
/** Shared registration validation for editing and read-only readiness. */
export function validateLocalEditingModel(input: unknown): LocalEditingModel {
  if (!contractValidator<LocalEditingModel>('LocalEditingModel')(input)) throw new PicPatchSdkError('INVALID_REQUEST', 'Invalid local editing model configuration.');
  absolutePath(input.directory);
  const loraPaths = input.loras?.map(lora => lora.path) ?? [];
  if (new Set(loraPaths.map(path => path.toLowerCase())).size !== loraPaths.length || loraPaths.some(path => !path.toLowerCase().endsWith('.safetensors') || !input.manifest.components.some(component => component.path === path && component.role === 'weights'))) throw new PicPatchSdkError('INVALID_REQUEST', 'LoRAs must be distinct declared safetensors weights.');
  if (isNativeVariant(input.variant)) {
    if (!input.checkpoint || input.quantize !== undefined) throw new PicPatchSdkError('INVALID_REQUEST', 'Native models require a checkpoint and use checkpoint-owned quantization.');
    const identity = input.variant === 'sdxl-photomaker-v1';
    const appearance = input.variant.includes('-ip-adapter');
    if (identity !== (input.photoMaker !== undefined) || appearance !== (input.ipAdapter !== undefined) || appearance !== (input.clipVision !== undefined)) throw new PicPatchSdkError('INVALID_REQUEST', 'Supply exactly the auxiliary assets required by the selected native conditioning method.');
    if (input.loras && !input.checkpoint.toLowerCase().endsWith('.safetensors')) throw new PicPatchSdkError('INVALID_REQUEST', 'LoRA compatibility checks require a safetensors checkpoint.');
    if (input.controlNet && (input.variant !== 'sd15' || !input.checkpoint.toLowerCase().endsWith('.safetensors') || !input.controlNet.path.toLowerCase().endsWith('.safetensors'))) throw new PicPatchSdkError('INVALID_REQUEST', 'ControlNet currently requires an SD1.5 base safetensors checkpoint and Canny safetensors asset.');
    for (const path of [...loraPaths, input.controlNet?.path, input.checkpoint, input.vae, input.photoMaker, input.ipAdapter, input.clipVision].filter(value => value !== undefined)) {
      if (!input.manifest.components.some(component => component.path === path && component.role === 'weights')) throw new PicPatchSdkError('INVALID_REQUEST', 'Native model files must be declared manifest weights.');
    }
  } else if (input.controlNet !== undefined || input.checkpoint !== undefined || input.vae !== undefined || input.photoMaker !== undefined || input.ipAdapter !== undefined || input.clipVision !== undefined) throw new PicPatchSdkError('INVALID_REQUEST', 'Checkpoint files belong to native model registrations.');

  return { ...structuredClone(input), manifest: validateModelManifest(input.manifest) };
}
function inside(root: string, path: string): boolean {
  const child = relative(root, path);
  return child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}
async function* readChunks(file: FileHandle, bytes: number, signal?: AbortSignal): AsyncGenerator<Buffer> {
  let position = 0;
  while (position <= bytes) {
    checkSignal(signal);
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, bytes + 1 - position));
    const read = await file.read(buffer, 0, buffer.length, position);
    checkSignal(signal);
    if (!read.bytesRead) return;
    position += read.bytesRead;
    yield buffer.subarray(0, read.bytesRead);
  }
}
async function validIndex(stream: AsyncIterable<Buffer>, component: ModelComponent, manifest: ModelManifest, signal?: AbortSignal): Promise<boolean> {
  const weights = new Set(manifest.components.filter(c => c.role === 'weights').map(c => c.path));
  let valid = true; let depth = 0; let key = ''; let inMap = false; let maps = 0; let count = 0;
  try {
    await pipeline(stream, parser.asStream({ streamValues: false }), async tokens => {
      for await (const token of tokens) {
        checkSignal(signal);
        const { name, value } = token as { name: string; value?: unknown };
        if (name === 'keyValue') { if (depth === 1) key = String(value); continue; }
        if (name === 'startObject' || name === 'startArray') {
          if (depth === 0 && name !== 'startObject') valid = false;
          if (depth === 1 && key === 'weight_map') { maps++; inMap = name === 'startObject'; if (!inMap) valid = false; }
          else if (inMap && depth === 2) valid = false;
          depth++;
        } else if (name === 'endObject' || name === 'endArray') {
          if (depth === 2) inMap = false;
          depth--;
        } else if (name.endsWith('Value')) {
          if (depth === 1 && key === 'weight_map') valid = false;
          if (inMap && depth === 2) {
            count++;
            if (name !== 'stringValue' || typeof value !== 'string' || !componentPath(value) || !weights.has(posix.join(posix.dirname(component.path), value))) valid = false;
          }
        }
      }
    });
  } catch (cause) {
    checkSignal(signal);
    if ((cause as NodeJS.ErrnoException).code) throw cause;
    return false;
  }
  return valid && maps === 1 && count > 0;
}
async function verifyComponent(root: string, component: ModelComponent, manifest: ModelManifest, options: ModelOperationOptions): Promise<VerifiedComponent> {
  const path = join(root, ...component.path.split('/'));
  const result = (status: VerifiedComponent['status'], sha256?: string): VerifiedComponent => ({ path: component.path, status, ...(sha256 ? { sha256 } : {}) });
  try {
    // File symlinks support shared cache blobs; directory links cannot escape the selected root.
    if (!inside(root, await realpath(dirname(path)))) return result('path-escape');
    const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const before = await file.stat({ bigint: true });
      if (!before.isFile()) return result('not-file');
      if (before.size !== BigInt(component.bytes)) return result('size-mismatch');
      const hash = createHash('sha256');
      // Own the descriptor until the stream settles, including aborts.
      const stream = readChunks(file, component.bytes, options.signal);
      for await (const chunk of stream) {
        checkSignal(options.signal);
        const bytes = chunk as Buffer; hash.update(bytes);
      }
      checkSignal(options.signal);
      const digest = hash.digest('hex');
      if (digest !== component.sha256) return result('digest-mismatch', digest);
      const indexValid = component.role !== 'shard-index' || await validIndex(readChunks(file, component.bytes, options.signal), component, manifest, options.signal);
      const after = await file.stat({ bigint: true });
      const current = await stat(path, { bigint: true });
      if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || current.dev !== before.dev || current.ino !== before.ino) return result('changed');
      if (!indexValid) return result('invalid-index', digest);
      return result('verified', digest);
    } finally { await file.close(); }
  } catch (cause) {
    checkSignal(options.signal);
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return result('missing');
    if ((cause as NodeJS.ErrnoException).code === 'ENOTDIR') return result('not-file');
    throw cause;
  }
}
/** Matches caller-supplied pins; does not establish upstream trust or inference support. */
async function verifyModelOperation(path: string, input: ModelManifest, options: ModelVerificationOptions = {}): Promise<ModelVerification> {
  absolutePath(path); validateOperation(options, ['timeoutMs']); const manifest = validateModelManifest(input);
  checkSignal(options.signal);
  const budget = timeBudget(options.timeoutMs, 600_000);
  return withDeadline(options.signal, budget, 'Model verification timed out.', async signal => {
    const operation = { ...options, signal };
    try {
      const root = await realpath(path);
      if (!(await stat(root)).isDirectory()) throw new PicPatchSdkError('INVALID_REQUEST', 'Model verification requires a directory.');
      const components: VerifiedComponent[] = [];
      for (const component of manifest.components) {
        emitProgress(operation, { type: 'progress', verb: 'verifyModel', stage: 'verifying', message: 'Verifying a model component.', path: join(path, component.path) });
        components.push(await verifyComponent(root, component, manifest, operation));
      }
      checkSignal(operation.signal);
      return { path, manifest, components, status: components.every(c => c.status === 'verified') ? 'matches-manifest' : 'invalid', compatibility: 'unknown' };
    } catch (cause) {
      checkSignal(options.signal);
      if (cause instanceof PicPatchSdkError) throw cause;
      throw new PicPatchSdkError('MODEL_IO', 'Could not verify the selected model files.', { cause });
    }
  });
}

export function verifyModel(path: string, input: ModelManifest, options: ModelVerificationOptions = {}): Promise<ModelVerification> {
  return withDiagnostics('verifyModel', options, operation => verifyModelOperation(path, input, operation));
}
