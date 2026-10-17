import { inputGeometry } from './images/geometry.ts';
import { resolveParameters } from './parameters.ts';
import { extname, isAbsolute, resolve } from 'node:path';
import { contractValidator } from './contracts.ts';
import { PicPatchRuntimeError, PicPatchUsageError } from './errors.ts';
import type { GenerateRequest, EditRequest, ImageSize, ModelCapabilities } from './types.ts';

const requestValid = contractValidator<EditRequest>('EditRequest');
const generationValid = contractValidator<GenerateRequest>('GenerateRequest');
const capabilitiesValid = contractValidator<ModelCapabilities>('ModelCapabilities');

/** Validate metadata only; opening images and reserving output happens at execution. */
export function validateEditRequest(input: unknown, capabilities?: ModelCapabilities): EditRequest {
  if (!requestValid(input)) throw new PicPatchUsageError('INVALID_REQUEST', 'Invalid edit request: check required fields, image conditioning, numeric bounds, and unknown fields.');
  const request = structuredClone(input);
  if (request.outpaint) {
    if (request.maskImage) throw new PicPatchUsageError('INVALID_REQUEST', 'Outpainting creates its own mask; omit maskImage.');
    if (request.size && (request.size.width !== request.outpaint.size.width || request.size.height !== request.outpaint.size.height)) throw new PicPatchUsageError('INVALID_REQUEST', 'Output size must match the outpaint canvas.');
  }
  const groups = request.references ?? [];
  if (new Set(groups.map(group => group.id)).size !== groups.length) {
    throw new PicPatchUsageError('INVALID_REQUEST', 'Reference group IDs must be unique.');
  }
  const references = groups.flatMap(group => group.images);
  const inputs = [...references, ...(request.sourceImage ? [request.sourceImage] : []), ...(request.maskImage ? [request.maskImage] : [])];
  if ([...inputs, request.outputPath].some(path => !isAbsolute(path))) {
    throw new PicPatchUsageError('INVALID_REQUEST', 'Image paths must be absolute.');
  }
  if (extname(request.outputPath).toLowerCase() !== '.png') throw new PicPatchUsageError('INVALID_REQUEST', 'Output must have a .png extension.');
  if (inputs.some(path => resolve(path) === resolve(request.outputPath))) {
    throw new PicPatchUsageError('OUTPUT_CONFLICT', 'Output must not replace an input image.');
  }
  if (new Set(references.map(path => resolve(path))).size !== references.length) {
    throw new PicPatchUsageError('INVALID_REQUEST', 'Reference image paths must be unique across groups.');
  }
  if (capabilities) {
    if (!capabilitiesValid(capabilities)) throw new PicPatchRuntimeError('INVALID_CAPABILITIES', 'Worker returned invalid model capabilities.');
    const unsupported = (message: string): never => { throw new PicPatchUsageError('UNSUPPORTED_CAPABILITY', message); };
    if (capabilities.model !== request.model) unsupported('Capabilities do not describe the requested model.');
    if (capabilities.sourceImageRequired && !request.sourceImage) unsupported('This model requires a source image.');
    if (capabilities.maskRequired && !request.maskImage && !request.outpaint) unsupported('This model requires a mask image.');
    if (!capabilities.instructionEditing) unsupported('This model does not support instruction editing.');
    if (request.maskImage && capabilities.maskMode === 'none') unsupported('This model does not support masks.');
    if (groups.some(group => !capabilities.referenceRoles.includes(group.role))) unsupported('This model does not support a requested reference role.');
    if (capabilities.maxReferenceImages !== undefined && references.length > capabilities.maxReferenceImages) unsupported('The reference count exceeds this model’s supported limit.');
    if (capabilities.maxConditioningImages !== undefined && references.length + (request.sourceImage ? 1 : 0) > capabilities.maxConditioningImages) unsupported('The total source and reference count exceeds this model’s supported limit.');
    if (request.outpaint) {
      if (!capabilities.outpainting || capabilities.maskMode === 'none') unsupported('This model does not support outpainting.');
      validateSize(request.outpaint.size, capabilities);
      const canvas = request.outpaint.size;
      const geometry = inputGeometry(canvas.width, canvas.height, 1, capabilities.inputGeometry);
      if (geometry.preparedSize.width !== canvas.width || geometry.preparedSize.height !== canvas.height) unsupported('Outpaint canvas must not require model cropping or downscaling.');
    }
    const conditioning = capabilities.referenceConditioning;
    if (conditioning === 'pooled-identity' || conditioning === 'appearance-embedding') {
      if (request.sourceImage || request.maskImage || request.outpaint || groups.length !== 1) unsupported('Dedicated reference conditioning requires exactly one group and no source or mask.');
      const group = groups[0]!;
      if (conditioning === 'pooled-identity') {
        if (group.conditioning !== 'identity' || !group.className) unsupported('Identity conditioning requires an identity group and className.');
        const placeholder = `{${group.id}}`;
        if (request.instruction.split(placeholder).length !== 2 || /\bimg\b/i.test(request.instruction.replace(placeholder, ''))) unsupported('Use the identity group placeholder exactly once; the SDK supplies the native trigger word.');
      } else if (group.conditioning !== 'appearance' || group.className) unsupported('Appearance conditioning requires an appearance group without an identity class.');
    } else if (groups.some(group => (group.conditioning !== undefined && group.conditioning !== 'prompt') || group.className !== undefined)) unsupported('This model supports prompt grouping, not dedicated identity or appearance conditioning.');
    resolveParameters(request.parameters, capabilities);
    validateSize(request.size, capabilities);
  }
  return request;
}

function validateSize(size: ImageSize | undefined, capabilities: ModelCapabilities): void {
  const limits = capabilities.size;
  if (size && limits && (size.width % limits.widthMultiple !== 0 || size.height % limits.heightMultiple !== 0 ||
    (limits.maxWidth !== undefined && size.width > limits.maxWidth) || (limits.maxHeight !== undefined && size.height > limits.maxHeight))) {
    throw new PicPatchUsageError('UNSUPPORTED_CAPABILITY', 'The requested dimensions are unsupported by this model.');
  }
}

export function validateGenerateRequest(input: unknown, capabilities?: ModelCapabilities): GenerateRequest {
  if (!generationValid(input)) throw new PicPatchUsageError('INVALID_REQUEST', 'Invalid generation request: check prompt, output, numeric bounds, and unknown fields.');
  const request = structuredClone(input);
  if (!isAbsolute(request.outputPath) || extname(request.outputPath).toLowerCase() !== '.png') {
    throw new PicPatchUsageError('INVALID_REQUEST', 'Output must be an absolute path with a .png extension.');
  }
  if (capabilities) {
    if (!capabilitiesValid(capabilities)) throw new PicPatchRuntimeError('INVALID_CAPABILITIES', 'Worker returned invalid model capabilities.');
    if (capabilities.model !== request.model || capabilities.textToImage !== true) {
      throw new PicPatchUsageError('UNSUPPORTED_CAPABILITY', 'This model does not advertise text-to-image generation.');
    }
    resolveParameters(request.parameters, capabilities, 'generate');
    validateSize(request.size, capabilities);
  }
  return request;
}
