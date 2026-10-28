import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from '../../storage.ts';
import { join } from 'node:path';
import { contractValidator } from '../../contracts.ts';
import type { LocalLora } from '../../contracts.generated.ts';
import { PicPatchSdkError } from '../../errors.ts';
import { checkSignal, emitProgress } from '../../operations.ts';
import { safetensorsHeader } from '../../models/safetensors.ts';
import { validateModelManifest, verifyBundle } from '../../models/verification.ts';
import type { PreparedModel, PrepareModelOptions } from '../../models/preparation.ts';

export function validateMfluxLoras(loras: unknown): asserts loras is [LocalLora, ...LocalLora[]] {
  if (!Array.isArray(loras) || !loras.length || loras.some(lora => !contractValidator<LocalLora>('LocalLora')(lora) || !lora.path.toLowerCase().endsWith('.safetensors'))) throw new PicPatchSdkError('INVALID_REQUEST', 'Supply local safetensors LoRAs with finite scales.');
  validateModelManifest({ version: 1, model: 'loras', source: { repository: 'local', revision: '0'.repeat(64) }, components: loras.map(lora => ({ path: lora.path, role: 'weights', bytes: 1, sha256: '0'.repeat(64) })) });
}

/** Preparation checks the container/pairs; the installed runtime owns family target mappings. */
export async function attachMfluxLoras(prepared: PreparedModel, loras: [LocalLora, ...LocalLora[]], options: PrepareModelOptions): Promise<PreparedModel> {
  const model = prepared.model;
  const components = [...model.manifest.components];
  for (const lora of loras) {
    checkSignal(options.signal);
    const path = join(model.directory, lora.path);
    const header = await safetensorsHeader(path, options.signal);
    validateLoraHeader(header);
    emitProgress(options, { type: 'progress', verb: 'prepareModel', stage: 'loras', completed: loras.indexOf(lora), total: loras.length, message: 'Fingerprinting local LoRA weights.', path: lora.path });
    const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const before = await file.stat({ bigint: true });
      if (!before.isFile() || before.size <= 0n || before.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new PicPatchSdkError('MODEL_COMPONENT_INVALID', 'Select regular LoRA weights.');
      const hash = createHash('sha256'); const buffer = Buffer.allocUnsafe(65536); let bytes = 0;
      while (bytes <= Number(before.size)) {
        checkSignal(options.signal);
        const read = await file.read(buffer, 0, Math.min(buffer.length, Number(before.size) + 1 - bytes), bytes);
        if (!read.bytesRead) break;
        hash.update(buffer.subarray(0, read.bytesRead)); bytes += read.bytesRead;
      }
      const after = await file.stat({ bigint: true });
      if (bytes !== Number(before.size) || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw new PicPatchSdkError('MODEL_CHANGED', 'LoRA changed during preparation.');
      const component = { path: lora.path, role: 'weights' as const, bytes, sha256: hash.digest('hex') };
      const existing = components.find(item => item.path === lora.path);
      if (existing && (existing.sha256 !== component.sha256 || existing.role !== 'weights')) throw new PicPatchSdkError('MODEL_MISMATCH', 'LoRA conflicts with the prepared bundle.');
      if (!existing) components.push(component);
    } finally { await file.close(); }
    validateLoraHeader(await safetensorsHeader(path, options.signal));
  }
  const revision = createHash('sha256').update(JSON.stringify({ base: model.manifest.source, components })).digest('hex');
  const manifest = validateModelManifest({ ...model.manifest, source: { repository: 'local', revision }, components });
  // The base was just verified by its preparation owner; verify only auxiliary files here.
  const auxiliary = validateModelManifest({ ...manifest, components: components.filter(component => loras.some(lora => lora.path === component.path)) });
  const verification = await verifyBundle(model.directory, auxiliary, { ...(options.signal ? { signal: options.signal } : {}), onProgress: event => emitProgress(options, event) });
  if (verification.status !== 'matches-manifest') throw new PicPatchSdkError('MODEL_CHANGED', 'Prepared model or LoRA files changed.');
  return { ...prepared, integrity: 'locally-fingerprinted', model: { ...model, manifest, loras: structuredClone(loras) } };
}

function validateLoraHeader(header: Awaited<ReturnType<typeof safetensorsHeader>>): void {
  const pairs = new Map<string, { up?: number[]; down?: number[] }>();
  for (const [name, tensor] of Object.entries(header)) {
    if (name === '__metadata__') continue;
    const match = /^(.*)\.(lora_A|lora_B|lora_up|lora_down)(?:\.weight)?$/.exec(name);
    if (!match) {
      if (name.endsWith('.alpha') && Array.isArray(tensor.shape) && tensor.shape.reduce((a, b) => a * b, 1) === 1) continue;
      throw new PicPatchSdkError('INVALID_REQUEST', 'Only paired linear LoRA tensors and scalar alpha are supported.');
    }
    const pair = pairs.get(match[1]!) ?? {};
    const slot = ['lora_A', 'lora_down'].includes(match[2]!) ? 'down' : 'up';
    if (pair[slot] || !Array.isArray(tensor.shape) || tensor.shape.length !== 2 || tensor.shape.some(size => !Number.isSafeInteger(size) || size <= 0)) throw new PicPatchSdkError('INVALID_REQUEST', 'Invalid or ambiguous LoRA matrices.');
    pair[slot] = tensor.shape; pairs.set(match[1]!, pair);
  }
  if (!pairs.size || [...pairs.values()].some(pair => !pair.up || !pair.down || pair.up[1] !== pair.down[0])) throw new PicPatchSdkError('INVALID_REQUEST', 'LoRA up/down pairs must have matching ranks.');
}
