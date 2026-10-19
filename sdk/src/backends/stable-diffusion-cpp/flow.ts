import { join } from 'node:path';
import type { LocalModel, ModelCapabilities } from '../../contracts.generated.ts';
import { PicPatchSdkError } from '../../errors.ts';
import { safetensorsHeader } from '../../models/safetensors.ts';

export const flowVariants = ['sd35-large', 'chroma', 'chroma-radiance'] as const;
const isFlow = (variant: string): boolean => (flowVariants as readonly string[]).includes(variant);

/** Generation contracts audited against the pinned native source; no image-quality qualification. */
export function flowCapabilities(variant: string, model: string): ModelCapabilities {
  return { model, textToImage: true, instructionEditing: false, sourceImageRequired: false,
    maskRequired: false, outpainting: false, referenceRoles: [], maxReferenceImages: 0, maskMode: 'none',
    size: { widthMultiple: 32, heightMultiple: 32, maxWidth: 2147483616, maxHeight: 2147483616 },
    defaultOutputSize: { width: 1024, height: 1024 }, parameters: {
      steps: { default: 30, minimum: 1, maximum: 2147483647, integer: true },
      guidance: { default: variant === 'sd35-large' ? 4.5 : 4, minimum: 0, maximum: 3.4028234663852886e38 },
      negativePrompt: { default: '' }, sampler: { default: 'euler', values: ['euler'] },
      scheduler: { default: 'discrete', values: ['discrete'] },
    } };
}

export function validateFlowAssets(model: LocalModel): void {
  if (!isFlow(model.variant)) {
    if (model.clipL !== undefined || model.clipG !== undefined || model.t5 !== undefined) throw new PicPatchSdkError('INVALID_REQUEST', 'Separate text encoders require a supported native flow model.');
    return;
  }
  const sd3 = model.variant === 'sd35-large';
  if (!model.t5 || sd3 !== Boolean(model.clipL) || sd3 !== Boolean(model.clipG) ||
      (model.variant === 'chroma' && !model.vae) || (model.variant === 'chroma-radiance' && model.vae !== undefined) ||
      model.loras !== undefined || model.controlNet !== undefined || model.photoMaker !== undefined || model.ipAdapter !== undefined || model.clipVision !== undefined) {
    throw new PicPatchSdkError('INVALID_REQUEST', 'Supply the exact text encoders and VAE for the native model; auxiliary conditioning and LoRAs are not supported for these variants.');
  }
}

/** Components remain independent files. SD3's documented checkpoint contains its VAE. */
export function nativeWeightArguments(model: LocalModel): string[] {
  const split = model.variant === 'chroma' || model.variant === 'chroma-radiance';
  const args = [split ? '--diffusion-model' : '--model', join(model.directory, model.checkpoint!)];
  for (const [key, flag] of [['vae', '--vae'], ['clipL', '--clip_l'], ['clipG', '--clip_g'], ['t5', '--t5xxl']] as const) {
    if (model[key]) args.push(flag, join(model.directory, model[key]));
  }
  // Matches the pinned runtime's documented Chroma recipe; not exposed as an untyped escape hatch.
  if (model.variant === 'chroma') args.push('--model-args', 'chroma_use_dit_mask=false');
  return args;
}

/** Header recognition catches wrong families early, not completeness or trained quality. */
export async function inspectFlowAssets(model: LocalModel, signal?: AbortSignal): Promise<void> {
  validateFlowAssets(model);
  if (!model.checkpoint!.toLowerCase().endsWith('.safetensors')) return; // GGUF architecture is checked by runtime loading.
  const header = await safetensorsHeader(join(model.directory, model.checkpoint!), signal);
  const keys = Object.keys(header);
  const has = (fragment: string): boolean => keys.some(key => key.includes(fragment));
  const matches = model.variant === 'sd35-large'
    ? has('joint_blocks.37.') && has('x_embedder.proj.weight') && (Boolean(model.vae) || has('first_stage_model.decoder.'))
    : model.variant === 'chroma'
      ? has('double_blocks.') && has('distilled_guidance_layer.in_proj.weight') && !has('nerf_final_layer_conv.')
      : has('nerf_final_layer_conv.') && has('double_blocks.');
  if (!matches) throw new PicPatchSdkError('INVALID_REQUEST', 'Checkpoint header does not match the selected native flow architecture or lacks its required VAE.');
}
