import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Header-only structural fixtures, deliberately not valid inference weights. */
export async function tensorFile(path: string, shapes: Record<string, number[]>): Promise<void> {
  const header = Buffer.from(JSON.stringify(Object.fromEntries(Object.entries(shapes).map(([name, shape]) => [name, { dtype: 'F16', shape, data_offsets: [0, 0] }]))));
  const length = Buffer.alloc(8); length.writeBigUInt64LE(BigInt(header.length));
  await writeFile(path, Buffer.concat([length, header]));
}
export async function nativeAssets(directory: string, variant: string) {
  const xl = variant.startsWith('sdxl'); const identity = variant.includes('photomaker'); const plus = variant.endsWith('-plus');
  const context = xl ? 2048 : 768;
  await nativeCheckpoint(join(directory, 'checkpoint.safetensors'), variant);
  if (identity) {
    await tensorFile(join(directory, 'v2-name.safetensors'), {
      'vision_model.embeddings.patch_embedding.weight': [1024, 3, 14, 14],
      'visual_projection_2.weight': [1280, 1024], 'fuse_module.layer_norm.weight': [2048],
    });
    return { directory, checkpoint: 'checkpoint.safetensors', photoMaker: 'v2-name.safetensors' };
  }
  await tensorFile(join(directory, 'vision.safetensors'), {
    'vision_model.embeddings.patch_embedding.weight': [1280, 3, 14, 14], 'visual_projection.weight': [1024, 1280],
  });
  const dim = xl ? 1280 : 768;
  await tensorFile(join(directory, 'adapter.safetensors'), plus ? {
    'image_proj.latents': [1, 16, dim], 'image_proj.proj_in.weight': [dim, 1280], 'image_proj.proj_out.weight': [context, dim],
  } : { 'image_proj.norm.weight': [context], 'image_proj.proj.weight': [context * 4, 1024] });
  return { directory, checkpoint: 'checkpoint.safetensors', ipAdapter: 'adapter.safetensors', clipVision: 'vision.safetensors' };
}

export async function nativeCheckpoint(path: string, variant: string): Promise<void> {
  await tensorFile(path, {
    'model.diffusion_model.input_blocks.0.0.weight': [320, variant.endsWith('-inpaint') ? 9 : 4, 3, 3],
    'model.diffusion_model.input_blocks.1.1.transformer_blocks.0.attn2.to_k.weight': [320, variant.startsWith('sdxl') ? 2048 : 768],
  });
}

export function controlNetShapes(context = 768): Record<string, number[]> {
  return Object.fromEntries(Object.entries({
    'input_blocks.0.0.weight': [320, 4, 3, 3],
    'input_hint_block.0.weight': [16, 3, 3, 3],
    'zero_convs.0.0.weight': [320, 320, 1, 1],
    'middle_block_out.0.weight': [1280, 1280, 1, 1],
    'input_blocks.1.1.transformer_blocks.0.attn2.to_k.weight': [320, context],
  }).map(([key, value]) => [`control_model.${key}`, value]));
}
