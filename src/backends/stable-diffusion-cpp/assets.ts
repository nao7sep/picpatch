import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import type { LocalEditingModel } from '../../contracts.generated.ts';
import { checkSignal } from '../../operations.ts';
import { PicPatchRuntimeError, PicPatchUsageError } from '../../errors.ts';

type Header = Record<string, { shape?: number[] }>;
/** Safetensors' metadata only; never deserialize executable formats or load tensors. */
async function header(path: string, signal?: AbortSignal): Promise<Header> {
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size < 8) throw new PicPatchRuntimeError('MODEL_IO', 'Invalid safetensors asset.');
    const prefix = Buffer.alloc(8);
    if ((await file.read(prefix, 0, 8, 0)).bytesRead !== 8) throw new PicPatchRuntimeError('MODEL_IO', 'Incomplete safetensors header.');
    const length = prefix.readBigUInt64LE();
    // The safetensors format itself limits metadata to 100 MB.
    if (length > 100_000_000n || length < 2n || length > BigInt(info.size - 8)) throw new PicPatchRuntimeError('MODEL_IO', 'Invalid safetensors header length.');
    const bytes = Buffer.alloc(Number(length));
    let offset = 0;
    while (offset < bytes.length) {
      checkSignal(signal);
      const read = await file.read(bytes, offset, Math.min(65536, bytes.length - offset), offset + 8);
      if (!read.bytesRead) throw new PicPatchRuntimeError('MODEL_IO', 'Incomplete safetensors header.');
      offset += read.bytesRead;
    }
    const value: unknown = JSON.parse(bytes.toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new PicPatchRuntimeError('MODEL_IO', 'Invalid safetensors metadata.');
    return value as Header;
  } finally { await file.close(); }
}

/** Recognize the exact conventional exports supported by these conditioned workflows. */
async function inspectAssets(model: LocalEditingModel, signal?: AbortSignal): Promise<void> {
  if (!model.photoMaker && !model.ipAdapter) return;
  const required = [model.checkpoint!, ...(model.photoMaker ? [model.photoMaker] : [model.ipAdapter!, model.clipVision!])];
  if (required.some(path => !path.toLowerCase().endsWith('.safetensors'))) throw new PicPatchUsageError('INVALID_REQUEST', 'Conditioned workflows currently require safetensors checkpoint and auxiliary assets.');
  const incompatible = (): never => { throw new PicPatchUsageError('INVALID_REQUEST', 'Checkpoint and auxiliary tensor metadata are incompatible with the selected conditioning workflow.'); };
  const shape = (data: Header, name: string, expected: number[]): boolean => Array.isArray(data[name]?.shape) && JSON.stringify(data[name]!.shape) === JSON.stringify(expected);
  const checkpoint = await header(join(model.directory, model.checkpoint!), signal);
  const context = model.variant.startsWith('sdxl') ? 2048 : 768;
  if (!shape(checkpoint, 'model.diffusion_model.input_blocks.0.0.weight', [320, 4, 3, 3]) ||
    !Object.entries(checkpoint).some(([key, value]) => key.startsWith('model.diffusion_model.') && key.endsWith('.attn2.to_k.weight') && value?.shape?.length === 2 && value.shape[1] === context)) incompatible();
  if (model.photoMaker) {
    const identity = await header(join(model.directory, model.photoMaker), signal);
    if (!shape(identity, 'vision_model.embeddings.patch_embedding.weight', [1024, 3, 14, 14]) ||
      !shape(identity, 'visual_projection_2.weight', [1280, 1024]) ||
      !shape(identity, 'fuse_module.layer_norm.weight', [2048]) || Object.keys(identity).some(key => key.includes('qformer_perceiver'))) incompatible();
  } else {
    const vision = await header(join(model.directory, model.clipVision!), signal);
    if (!shape(vision, 'vision_model.embeddings.patch_embedding.weight', [1280, 3, 14, 14]) || !shape(vision, 'visual_projection.weight', [1024, 1280])) incompatible();
    const adapter = await header(join(model.directory, model.ipAdapter!), signal);
    if (model.variant.endsWith('-plus')) {
      const dim = context === 2048 ? 1280 : 768;
      if (!shape(adapter, 'image_proj.latents', [1, 16, dim]) || !shape(adapter, 'image_proj.proj_in.weight', [dim, 1280]) || !shape(adapter, 'image_proj.proj_out.weight', [context, dim])) incompatible();
    } else if (adapter['image_proj.latents'] || !shape(adapter, 'image_proj.norm.weight', [context]) || !shape(adapter, 'image_proj.proj.weight', [context * 4, 1024])) incompatible();
  }
}

export async function inspectConditioningAssets(model: LocalEditingModel, signal?: AbortSignal): Promise<void> {
  try { await inspectAssets(model, signal); }
  catch (cause) {
    checkSignal(signal);
    if (cause instanceof PicPatchUsageError || cause instanceof PicPatchRuntimeError) throw cause;
    throw new PicPatchRuntimeError('MODEL_IO', 'Could not inspect native conditioning metadata.', { cause });
  }
}
