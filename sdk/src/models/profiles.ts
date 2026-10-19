// What a caller needs to choose a model before preparing it: a display name, how heavy
// and slow it is, its licence kind, what it is good for, and what has actually run.
// Curated from the catalog's evidence (tests, benchmarks and the model survey); the
// capabilities in each definition stay the authority for what a model can do.

/** How a selection's behavior is known: real trained weights ran through this SDK, a tiny
 * random-weight runtime ran, only the adapter contract was tested, or only the CLI source was audited. */
export type Evidence = 'real-weights' | 'tiny-runtime' | 'api' | 'source';
export type Operation = 'generate' | 'edit' | 'references' | 'mask' | 'outpaint' | 'control' | 'lora';
export type Purpose = 'drafts' | 'photoreal' | 'illustration' | 'text' | 'design' | 'editing' | 'inpainting' | 'outpainting' | 'identity' | 'style' | 'structure' | 'finetuning';
/** recommended: a first choice for its jobs; standard: a sound alternative; specialist: base, research or very heavy. */
export type Tier = 'recommended' | 'standard' | 'specialist';
/** Approximate resident memory at default settings: light under 8 GB, medium under 16 GB, heavy under 32 GB, very-heavy beyond. */
export type MemoryClass = 'light' | 'medium' | 'heavy' | 'very-heavy';
/** Approximate time for one default image on an Apple M4: fast under 30 s, medium under 2 min, slow beyond. */
export type SpeedClass = 'fast' | 'medium' | 'slow';
/** commercial: the weights' licence permits commercial use; non-commercial: it does not; check: terms vary or need review. */
export type LicenceKind = 'commercial' | 'non-commercial' | 'check';

export interface ModelProfile {
  name: string;
  /** Generator parameters in billions, excluding text encoders. */
  parameters: number;
  memory: MemoryClass;
  speed: SpeedClass;
  licence: LicenceKind;
  purposes: Purpose[];
  tier: Tier;
}

const p = (name: string, parameters: number, memory: MemoryClass, speed: SpeedClass, licence: LicenceKind, purposes: Purpose[], tier: Tier = 'standard'): ModelProfile =>
  ({ name, parameters, memory, speed, licence, purposes, tier });

/** One profile per variant; a pinned quantization and the caller's own files share it. */
const profiles: Record<string, ModelProfile> = {
  'flux2-klein-4b': p('FLUX.2 Klein 4B', 4, 'light', 'fast', 'commercial', ['drafts', 'editing', 'photoreal', 'inpainting', 'outpainting'], 'recommended'),
  'flux2-klein-9b': p('FLUX.2 Klein 9B', 9, 'heavy', 'slow', 'non-commercial', ['photoreal', 'editing']),
  'flux2-klein-base-4b': p('FLUX.2 Klein Base 4B', 4, 'light', 'slow', 'commercial', ['finetuning'], 'specialist'),
  'flux2-klein-base-9b': p('FLUX.2 Klein Base 9B', 9, 'heavy', 'slow', 'non-commercial', ['finetuning', 'photoreal'], 'specialist'),
  'z-image-turbo': p('Z-Image Turbo', 6, 'medium', 'medium', 'commercial', ['photoreal', 'text'], 'recommended'),
  'z-image': p('Z-Image', 6, 'medium', 'slow', 'commercial', ['finetuning', 'photoreal'], 'specialist'),
  'flux1-schnell': p('FLUX.1 schnell', 12, 'heavy', 'medium', 'commercial', ['drafts', 'illustration']),
  'flux1-dev': p('FLUX.1 dev', 12, 'heavy', 'slow', 'non-commercial', ['photoreal', 'illustration']),
  'flux1-krea-dev': p('FLUX.1 Krea dev', 12, 'heavy', 'slow', 'non-commercial', ['photoreal']),
  'flux1-fill-dev': p('FLUX.1 Fill dev', 12, 'heavy', 'slow', 'non-commercial', ['inpainting', 'outpainting'], 'recommended'),
  'flux1-kontext-dev': p('FLUX.1 Kontext dev', 12, 'heavy', 'slow', 'non-commercial', ['editing']),
  'ernie-image': p('ERNIE-Image', 8, 'heavy', 'slow', 'check', ['photoreal', 'text'], 'specialist'),
  'ernie-image-turbo': p('ERNIE-Image Turbo', 8, 'heavy', 'medium', 'check', ['photoreal', 'text']),
  'qwen-image': p('Qwen-Image', 20, 'very-heavy', 'slow', 'commercial', ['text', 'design'], 'specialist'),
  'qwen-image-edit-2511': p('Qwen-Image-Edit 2511', 20, 'very-heavy', 'slow', 'commercial', ['editing', 'text'], 'specialist'),
  'qwen-image-2.1': p('Qwen-Image 2.1', 7.1, 'heavy', 'slow', 'check', ['editing', 'text', 'design', 'inpainting', 'outpainting']),
  'krea-2': p('Krea 2', 12, 'heavy', 'medium', 'check', ['photoreal', 'illustration']),
  'krea-2-raw': p('Krea 2 Raw', 12, 'heavy', 'medium', 'check', ['finetuning'], 'specialist'),
  'boogu-image-turbo': p('Boogu Image Turbo', 10, 'heavy', 'medium', 'check', ['photoreal']),
  'ming-image-design': p('Ming-Image Design', 6, 'very-heavy', 'slow', 'check', ['design', 'text'], 'specialist'),
  'ideogram4-fp8': p('Ideogram 4 FP8', 9.3, 'very-heavy', 'slow', 'non-commercial', ['design', 'text'], 'specialist'),
  'flux1-dreamo-v1.1': p('DreamO 1.1', 12, 'very-heavy', 'slow', 'non-commercial', ['identity'], 'specialist'),
  'glm-image': p('GLM-Image', 16, 'very-heavy', 'slow', 'check', ['text', 'editing'], 'specialist'),
  'flux2-dev': p('FLUX.2 dev', 32, 'very-heavy', 'slow', 'non-commercial', ['photoreal', 'editing'], 'specialist'),
  sd15: p('Stable Diffusion 1.5', 0.9, 'light', 'fast', 'commercial', ['drafts', 'structure', 'illustration']),
  sdxl: p('Stable Diffusion XL', 2.6, 'medium', 'medium', 'commercial', ['photoreal', 'illustration', 'structure']),
  'sd15-inpaint': p('Stable Diffusion 1.5 Inpainting', 0.9, 'light', 'fast', 'commercial', ['inpainting', 'outpainting']),
  'sdxl-inpaint': p('Stable Diffusion XL Inpainting', 2.6, 'medium', 'medium', 'commercial', ['inpainting', 'outpainting']),
  'sdxl-photomaker-v1': p('SDXL PhotoMaker 1', 2.6, 'medium', 'medium', 'commercial', ['identity'], 'recommended'),
  'sd15-ip-adapter': p('SD 1.5 IP-Adapter', 0.9, 'light', 'fast', 'commercial', ['style']),
  'sdxl-ip-adapter': p('SDXL IP-Adapter', 2.6, 'medium', 'medium', 'commercial', ['style']),
  'sd15-ip-adapter-plus': p('SD 1.5 IP-Adapter Plus', 0.9, 'light', 'fast', 'commercial', ['style'], 'specialist'),
  'sdxl-ip-adapter-plus': p('SDXL IP-Adapter Plus', 2.6, 'medium', 'medium', 'commercial', ['style']),
  'sd35-large': p('Stable Diffusion 3.5 Large', 8, 'heavy', 'slow', 'check', ['photoreal', 'text'], 'specialist'),
  chroma: p('Chroma', 8.9, 'heavy', 'slow', 'commercial', ['photoreal', 'illustration'], 'specialist'),
  'chroma-radiance': p('Chroma Radiance', 8.9, 'heavy', 'slow', 'commercial', ['photoreal'], 'specialist'),
  'hidream-o1': p('HiDream O1', 8, 'heavy', 'slow', 'check', ['editing', 'photoreal'], 'specialist'),
  'hidream-o1-dev': p('HiDream O1 dev', 8, 'heavy', 'slow', 'check', ['editing', 'photoreal'], 'specialist'),
};

export function modelProfile(variant: string): ModelProfile {
  const found = profiles[variant];
  if (!found) throw new Error(`Missing model profile: ${variant}`);
  return structuredClone(found);
}

/** Selections whose exact configuration ran with real trained weights in this SDK's live lanes, and what ran. */
const realWeights: Record<string, Operation[]> = {
  'flux2-klein-4b-4bit': ['generate', 'edit', 'references', 'mask', 'outpaint', 'lora'],
  'flux2-klein-9b-4bit': ['generate', 'edit'],
  'flux2-klein-base-9b-4bit': ['generate', 'edit'],
  'z-image-turbo-4bit': ['generate'],
  'flux1-fill-dev-4bit': ['mask'],
  sd15: ['generate', 'edit', 'control', 'lora'],
  'sd15-inpaint': ['mask', 'outpaint'],
  sdxl: ['generate', 'edit', 'lora'],
  'sdxl-photomaker-v1': ['references'],
  'sd15-ip-adapter': ['references'],
  'sdxl-ip-adapter': ['references'],
  'sdxl-ip-adapter-plus': ['references'],
};
/** Runtimes exercised only with tiny random weights. */
const tinyRuntime = new Set(['flux1-dreamo-v1.1', 'glm-image', 'flux2-dev']);

export function modelEvidence(id: string, fallback: Evidence): { evidence: Evidence; tested: Operation[] } {
  const tested = realWeights[id];
  if (tested) return { evidence: 'real-weights', tested: [...tested] };
  return { evidence: tinyRuntime.has(id) ? 'tiny-runtime' : fallback, tested: [] };
}
