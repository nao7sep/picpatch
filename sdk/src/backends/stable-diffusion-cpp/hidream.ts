import { join } from 'node:path';
import type { LocalModel, ModelCapabilities, EditRequest } from '../../contracts.generated.ts';
import { PicPatchSdkError } from '../../errors.ts';
import { safetensorsHeader } from '../../models/safetensors.ts';

export const hiDreamVariants = ['hidream-o1', 'hidream-o1-dev'] as const;
export const isHiDream = (variant: string): boolean => (hiDreamVariants as readonly string[]).includes(variant);

/** Combined Pixel-DiT checkpoint; the pinned native runtime embeds its Qwen tokenizer. */
export function validateHiDreamAssets(model: LocalModel): void {
  if ([model.vae, model.clipL, model.clipG, model.t5, model.photoMaker, model.ipAdapter, model.clipVision, model.controlNet, model.loras].some(value => value !== undefined)) {
    throw new PicPatchSdkError('INVALID_REQUEST', 'HiDream O1 uses one combined checkpoint without auxiliary encoders, a VAE, LoRAs or structural conditioning.');
  }
}

export async function inspectHiDreamAssets(model: LocalModel, signal?: AbortSignal): Promise<void> {
  validateHiDreamAssets(model);
  if (!model.checkpoint!.toLowerCase().endsWith('.safetensors')) return; // Native loading checks GGUF architecture.
  const header = await safetensorsHeader(join(model.directory, model.checkpoint!), signal);
  // Architecture recognition, not a substitute for loading every tensor. Full and Dev
  // share shapes; their trained variant remains the caller's explicit selection.
  const required = { 'model.x_embedder.proj1.weight': [1024, 3072], 'model.language_model.layers.0.self_attn.q_proj.weight': [4096, 4096], 'model.visual.patch_embed.proj.weight': [1152, 3, 2, 16, 16], 'model.final_layer2.linear.weight': [3072, 4096] };
  if (Object.entries(required).some(([key, shape]) => JSON.stringify(header[key]?.shape) !== JSON.stringify(shape))) throw new PicPatchSdkError('INVALID_REQUEST', 'Supply a combined HiDream O1 checkpoint containing the pixel model, language model and vision encoder.');
}

export function hiDreamCapabilities(variant: string, model: string): ModelCapabilities {
  const dev = variant === 'hidream-o1-dev';
  return { model, textToImage: true, instructionEditing: true, sourceImageRequired: false,
    maskRequired: false, outpainting: false, maskMode: 'none', referenceRoles: ['subject', 'style', 'object', 'background'],
    referenceConditioning: 'ordered-images-with-role-prompt',
    size: { widthMultiple: 32, heightMultiple: 32, maxWidth: 2147483616, maxHeight: 2147483616 },
    defaultOutputSize: { width: 1024, height: 1024 }, parameters: {
      steps: { default: dev ? 28 : 50, minimum: 1, maximum: 2147483647, integer: true },
      guidance: { default: dev ? 1 : 5, minimum: 1, maximum: dev ? 1 : 3.4028234663852886e38 },
      ...(dev ? {} : { negativePrompt: { default: '' } }),
      sampler: { default: 'euler', values: ['euler'] }, scheduler: { default: 'discrete', values: ['discrete'] },
    } };
}

/** Native reference order is source first, then every group in caller order. */
export function hiDreamConditioning(request: EditRequest): { paths: string[]; prompt: string } {
  const paths: string[] = []; const descriptions: string[] = [];
  if (request.sourceImage) { paths.push(request.sourceImage); descriptions.push('Image 1 is the source image to edit.'); }
  for (const group of request.references ?? []) {
    const numbers = group.images.map(image => { paths.push(image); return paths.length; });
    descriptions.push(`Images ${numbers.join(', ')} are ${group.role} references for group ${JSON.stringify(group.id)}.`);
  }
  return { paths, prompt: `${descriptions.join('\n')}\n\n${request.instruction}` };
}
