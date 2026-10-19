import { flowCapabilities, flowVariants } from './flow.ts';
import { nativeRelease } from '../../runtime/engine/native-release.ts';
import type { ModelCapabilities } from '../../contracts.generated.ts';

/** Source-audited CLI contract; native inference evidence remains separate. */
export { nativeRevision };
const nativeRevision = nativeRelease.revision;
export const nativeVariants = ['sd15', 'sdxl', 'sd15-inpaint', 'sdxl-inpaint', 'sdxl-photomaker-v1', 'sd15-ip-adapter', 'sdxl-ip-adapter', 'sd15-ip-adapter-plus', 'sdxl-ip-adapter-plus', ...flowVariants] as const;
export function isNativeVariant(variant: string): boolean { return (nativeVariants as readonly string[]).includes(variant); }
export function nativeCapabilities(variant: string, model: string = variant): ModelCapabilities {
  if ((flowVariants as readonly string[]).includes(variant)) return flowCapabilities(variant, model);
  const masked = variant.endsWith('-inpaint');
  const identity = variant === 'sdxl-photomaker-v1';
  const appearance = variant.includes('-ip-adapter');
  const conditioned = identity || appearance;
  const dimension = variant.startsWith('sdxl') ? 1024 : 512;
  return { model, ...(['sd15', 'sdxl'].includes(variant) ? { controlKinds: ['canny' as const, 'depth' as const, 'pose' as const] } : {}), loraFormats: ['sd-unet-safetensors'], textToImage: !masked && !conditioned, instructionEditing: true, sourceImageRequired: !conditioned, maskRequired: masked, outpainting: masked,
    referenceRoles: identity ? ['subject'] : appearance ? ['style'] : [],
    ...(identity ? { referenceConditioning: 'pooled-identity' as const } : appearance ? { referenceConditioning: 'appearance-embedding' as const, maxReferenceImages: 1 } : { maxReferenceImages: 0 }), maskMode: masked ? 'native' : 'none',
    size: { widthMultiple: 8, heightMultiple: 8, maxWidth: 2147483640, maxHeight: 2147483640 }, defaultOutputSize: { width: dimension, height: dimension },
    parameters: { steps: { default: identity ? 50 : 20, minimum: 1, maximum: 2147483647, integer: true },
      guidance: { default: identity ? 5 : 7, minimum: 0, maximum: 3.4028234663852886e38 }, negativePrompt: { default: '' },
      scheduler: { default: 'discrete', values: ['discrete', 'karras', 'exponential'] }, sampler: { default: identity ? 'euler' : 'euler_a', values: ['euler', 'euler_a', 'heun', 'dpm2', 'dpm++2s_a', 'dpm++2m'] },
      ...(identity ? { identityStyleStrength: { default: 20, minimum: 0, maximum: 100 } } : appearance ? { appearanceStrength: { default: 1, minimum: 0, maximum: 3.4028234663852886e38 } } : { strength: { default: masked ? 1 : 0.75, minimum: masked ? 1 : 0, maximum: 1 } }) } };
}
export function nativeModels() {
  return nativeVariants.map(variant => ({ id: variant, variant, family: variant.startsWith('sdxl') ? 'sdxl' : variant.startsWith('sd15') ? 'sd15' : variant === 'sd35-large' ? 'sd3' : 'chroma',
    acquisition: 'external' as const, status: 'experimental' as const, evidence: 'source-audited' as const,
    capabilities: nativeCapabilities(variant), runtime: { name: 'stable-diffusion.cpp' as const, version: nativeRevision,
      platform: 'darwin' as const, architecture: 'arm64' as const } }));
}
