import { extname, isAbsolute, resolve } from 'node:path';
import { contractValidator } from './contracts.ts';
import { PicPatchRuntimeError, PicPatchUsageError } from './errors.ts';
import type { EditRequest, ModelCapabilities } from './types.ts';

const requestValid = contractValidator<EditRequest>('EditRequest');
const capabilitiesValid = contractValidator<ModelCapabilities>('ModelCapabilities');

/** Validate metadata only; opening images and reserving output happens at execution. */
export function validateEditRequest(input: unknown, capabilities?: ModelCapabilities): EditRequest {
  if (!requestValid(input)) throw new PicPatchUsageError('INVALID_REQUEST', 'Invalid edit request: check required fields, image conditioning, numeric bounds, and unknown fields.');
  const request = structuredClone(input);
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
    if (!capabilities.instructionEditing) unsupported('This model does not support instruction editing.');
    if (request.maskImage && capabilities.maskMode === 'none') unsupported('This model does not support masks.');
    if (groups.some(group => !capabilities.referenceRoles.includes(group.role))) unsupported('This model does not support a requested reference role.');
    if (capabilities.maxReferenceImages !== undefined && references.length > capabilities.maxReferenceImages) unsupported('The reference count exceeds this model’s supported limit.');
    const size = request.size;
    const limits = capabilities.size;
    if (size && limits && (size.width % limits.widthMultiple !== 0 || size.height % limits.heightMultiple !== 0 ||
      (limits.maxWidth !== undefined && size.width > limits.maxWidth) || (limits.maxHeight !== undefined && size.height > limits.maxHeight))) {
      unsupported('The requested dimensions are unsupported by this model.');
    }
  }
  return request;
}
