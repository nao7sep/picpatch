import { validateLoraTensors } from './lora.ts';
import { safetensorsHeader as header, type Header } from '../../models/safetensors.ts';
import { join } from 'node:path';
import type { LocalEditingModel } from '../../contracts.generated.ts';
import { checkSignal } from '../../operations.ts';
import { PicPatchSdkError } from '../../errors.ts';

/** Recognize conventional SD checkpoints and the supported conditioning exports. */
async function inspectAssets(model: LocalEditingModel, signal?: AbortSignal): Promise<void> {
  const conditioned = Boolean(model.photoMaker || model.ipAdapter);
  const required = [model.checkpoint!, ...[model.photoMaker, model.ipAdapter, model.clipVision].filter((path): path is string => path !== undefined)];
  if (conditioned && required.some(path => !path.toLowerCase().endsWith('.safetensors'))) throw new PicPatchSdkError('INVALID_REQUEST', 'Conditioned workflows currently require safetensors checkpoint and auxiliary assets.');
  const incompatible = (): never => { throw new PicPatchSdkError('INVALID_REQUEST', 'Checkpoint and auxiliary tensor metadata are incompatible with the selected conditioning workflow.'); };
  const shape = (data: Header, name: string, expected: number[]): boolean => Array.isArray(data[name]?.shape) && JSON.stringify(data[name]!.shape) === JSON.stringify(expected);
  const context = model.variant.startsWith('sdxl') ? 2048 : 768;
  if (model.checkpoint!.toLowerCase().endsWith('.safetensors')) {
    const checkpoint = await header(join(model.directory, model.checkpoint!), signal);
    for (const lora of model.loras ?? []) validateLoraTensors(checkpoint, await header(join(model.directory, lora.path), signal));
    const channels = model.variant.endsWith('-inpaint') ? 9 : 4;
    if (!shape(checkpoint, 'model.diffusion_model.input_blocks.0.0.weight', [320, channels, 3, 3]) ||
      !Object.entries(checkpoint).some(([key, value]) => key.startsWith('model.diffusion_model.') && key.endsWith('.attn2.to_k.weight') && value?.shape?.length === 2 && value.shape[1] === context)) {
      throw new PicPatchSdkError('INVALID_REQUEST', 'Checkpoint tensor metadata does not match the selected SD architecture and base/inpaint variant. Supply a conventional complete checkpoint; component-only exports are unsupported.');
    }
  }
  if (model.controlNet) {
    const data = await header(join(model.directory, model.controlNet.path), signal);
    const control = Object.fromEntries(Object.entries(data).map(([key, value]) => [key.replace(/^control_model\./, ''), value]));
    if (!shape(control, 'input_blocks.0.0.weight', [320, 4, 3, 3]) ||
      !shape(control, 'input_hint_block.0.weight', [16, 3, 3, 3]) ||
      !shape(control, 'zero_convs.0.0.weight', [320, 320, 1, 1]) ||
      !shape(control, 'middle_block_out.0.weight', [1280, 1280, 1, 1]) ||
      !(context === 2048
        ? shape(control, 'input_blocks.4.1.transformer_blocks.0.attn2.to_k.weight', [640, 2048]) &&
          shape(control, 'input_blocks.7.1.transformer_blocks.9.attn2.to_k.weight', [1280, 2048]) &&
          shape(control, 'label_emb.0.0.weight', [1280, 2816])
        : shape(control, 'input_blocks.1.1.transformer_blocks.0.attn2.to_k.weight', [320, 768]))) incompatible();
    // The pinned native runtime uses SDXL transformer depths {1,2,10} and ADM=2816.
    // Reject incompatible lightweight shapes rather than inferring compatibility from context alone.
    // These checks recognize conventional architecture, not every auxiliary tensor or union variant.
    // Shapes establish the selected ControlNet architecture; callers explicitly select
    // the map kind, which cannot be inferred from equal-shaped trained weights.
  }
  // GGUF architecture remains an explicit caller selection, checked by runtime loading.
  if (!conditioned) return;
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

export async function inspectNativeAssets(model: LocalEditingModel, signal?: AbortSignal): Promise<void> {
  try { await inspectAssets(model, signal); }
  catch (cause) {
    checkSignal(signal);
    if (cause instanceof PicPatchSdkError) throw cause;
    throw new PicPatchSdkError('MODEL_IO', 'Could not inspect native model metadata.', { cause });
  }
}
