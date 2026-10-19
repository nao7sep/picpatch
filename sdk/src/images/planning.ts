import { randomInt } from 'node:crypto';
import type { ImageRequest, GenerateRequest, EditRequest, InputGeometry, ModelCapabilities } from '../types.ts';
import { PicPatchSdkError } from '../errors.ts';
import { resolveParameters } from '../parameters.ts';
import { validateEditRequest, validateGenerateRequest } from '../validation.ts';
import { inputGeometry } from './geometry.ts';
import { inspectImage, type ImageFingerprint } from './fingerprint.ts';
import { validateImageMetadata } from './validation.ts';
import { inspectDestination, type PlannedDestination } from './output.ts';
import { outpaintMargins } from './outpaint.ts';

export interface PlannedImageInput {
  role: 'source' | 'mask' | 'reference' | 'control';
  path: string;
  fingerprint: ImageFingerprint;
  geometry: Omit<InputGeometry, 'path'>;
}
interface PlanData {
  status: 'planned';
  inputs: PlannedImageInput[];
  destination: PlannedDestination;
  capabilities: ModelCapabilities;
}
/** In-memory, immutable plan belonging to the editor that created it; not a persisted handoff format. */
export type GenerateImagePlan = Readonly<PlanData & { operation: 'generate'; request: GenerateRequest }>;
export type EditImagePlan = Readonly<PlanData & { operation: 'edit'; request: EditRequest }>;
export type ImagePlan = GenerateImagePlan | EditImagePlan;

export async function planImage(input: ImageRequest, capabilities: ModelCapabilities, signal?: AbortSignal): Promise<ImagePlan> {
  const generate = 'prompt' in input;
  const request = generate ? validateGenerateRequest(input, capabilities) : validateEditRequest(input, capabilities);
  const destination = await inspectDestination(request, signal);
  const inputs: PlannedImageInput[] = [];
  const references = new Set<string>();
  const inspect = async (path: string, role: PlannedImageInput['role'], preserve = false) => {
    const image = await inspectImage(path, signal);
    validateImageMetadata(image.metadata, role === 'mask', role === 'control');
    if (role === 'control' && image.metadata.hasAlpha) throw new PicPatchSdkError('INVALID_IMAGE', 'Control maps must be opaque PNG images.');
    const geometry = inputGeometry(image.metadata.width, image.metadata.height, image.metadata.orientation, preserve ? undefined : capabilities.inputGeometry);
    if (role === 'reference') {
      if (references.has(image.identity)) throw new PicPatchSdkError('INVALID_IMAGE', 'Reference images must not alias the same file.');
      references.add(image.identity);
    }
    inputs.push({ path, role, fingerprint: image.fingerprint, geometry });
    return geometry;
  };
  if ('instruction' in request) {
    const source = request.sourceImage ? await inspect(request.sourceImage, 'source', !!request.outpaint) : undefined;
    if (request.outpaint && source) {
      outpaintMargins(source.preparedSize, request.outpaint);
      request.size = { ...request.outpaint.size };
    }
    if (request.maskImage) {
      const mask = await inspect(request.maskImage, 'mask', true);
      if (!source || !sameSize(source.preparedSize, source.orientedSize) || !sameSize(mask.preparedSize, source.preparedSize)) throw new PicPatchSdkError('INVALID_MASK', 'Mask must match an unresized oriented source.');
      if (capabilities.maskMode !== 'native' && request.size && !sameSize(request.size, source.preparedSize)) throw new PicPatchSdkError('INVALID_MASK', 'Masked output dimensions must match the source.');
      request.size ??= { ...source.preparedSize };
    }
    for (const group of request.references ?? []) for (const path of group.images) await inspect(path, 'reference');
  }
  if (!request.size && capabilities.defaultOutputSize) request.size = { ...capabilities.defaultOutputSize };
  if (!request.size) throw new PicPatchSdkError('INVALID_CAPABILITIES', 'The model must advertise an output size for planning.');
  if (request.control) {
    const geometry = await inspect(request.control.image, 'control', true);
    if (!sameSize(geometry.preparedSize, request.size)) throw new PicPatchSdkError('INVALID_REQUEST', 'Control map dimensions must match output dimensions.');
    request.control.strength ??= 0.9;
  }
  request.seed ??= randomInt(0x1_0000_0000);
  request.parameters = resolveParameters(request.parameters, capabilities, generate ? 'generate' : 'edit');
  // Validate derived sizes too: source-sized masking must obey the model's multiples.
  if ('prompt' in request) validateGenerateRequest(request, capabilities); else validateEditRequest(request, capabilities);
  const data = { status: 'planned' as const, inputs, destination, capabilities: structuredClone(capabilities) };
  return deepFreeze('prompt' in request ? { ...data, operation: 'generate', request } : { ...data, operation: 'edit', request });
}
function sameSize(a: { width: number; height: number }, b: { width: number; height: number }): boolean { return a.width === b.width && a.height === b.height; }
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const item of Object.values(value)) deepFreeze(item); Object.freeze(value); }
  return value;
}
