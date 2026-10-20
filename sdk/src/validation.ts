import { inputGeometry } from './images/geometry.ts';
import { admissionIssues, type AdmissionRequest } from './admission.ts';
import { extname, isAbsolute, resolve } from 'node:path';
import { contractValidator } from './contracts.ts';
import { PicPatchSdkError } from './errors.ts';
import type { ImageRequest } from './types.ts';
import type { GenerateRequest, EditRequest, ModelCapabilities } from './types.ts';

const requestValid = contractValidator<EditRequest>('EditRequest');
const generationValid = contractValidator<GenerateRequest>('GenerateRequest');
const capabilitiesValid = contractValidator<ModelCapabilities>('ModelCapabilities');

/** Validate metadata only; opening images and reserving output happens at execution. */
export function validateEditRequest(input: unknown, capabilities?: ModelCapabilities): EditRequest {
  if (!requestValid(input)) throw new PicPatchSdkError('INVALID_REQUEST', 'Invalid edit request: check required fields, image conditioning, numeric bounds, and unknown fields.');
  const request = structuredClone(input);
  if (request.outpaint) {
    if (request.maskImage) throw new PicPatchSdkError('INVALID_REQUEST', 'Outpainting creates its own mask; omit maskImage.');
    if (request.size && (request.size.width !== request.outpaint.size.width || request.size.height !== request.outpaint.size.height)) throw new PicPatchSdkError('INVALID_REQUEST', 'Output size must match the outpaint canvas.');
  }
  if (capabilities && !capabilitiesValid(capabilities)) throw new PicPatchSdkError('PROTOCOL_ERROR', 'Worker returned invalid model capabilities.');
  validateControl(request);
  const groups = request.references ?? [];
  if (new Set(groups.map(group => group.id)).size !== groups.length) {
    throw new PicPatchSdkError('INVALID_REQUEST', 'Reference group IDs must be unique.');
  }
  const references = groups.flatMap(group => group.images);
  const inputs = [...references, ...(request.sourceImage ? [request.sourceImage] : []), ...(request.maskImage ? [request.maskImage] : [])];
  if ([...inputs, request.outputPath].some(path => !isAbsolute(path))) {
    throw new PicPatchSdkError('INVALID_REQUEST', 'Image paths must be absolute.');
  }
  if (extname(request.outputPath).toLowerCase() !== '.png') throw new PicPatchSdkError('INVALID_REQUEST', 'Output must have a .png extension.');
  if (inputs.some(path => resolve(path) === resolve(request.outputPath))) {
    throw new PicPatchSdkError('OUTPUT_CONFLICT', 'Output must not replace an input image.', { subject: request.outputPath });
  }
  if (new Set(references.map(path => resolve(path))).size !== references.length) {
    throw new PicPatchSdkError('INVALID_REQUEST', 'Reference image paths must be unique across groups.');
  }
  if (capabilities) {
    if (capabilities.model !== request.model) throw new PicPatchSdkError('UNSUPPORTED_CAPABILITY', 'Capabilities do not describe the requested model.');
    refuseIssues(request, capabilities);
    if (request.outpaint) {
      const canvas = request.outpaint.size;
      const geometry = inputGeometry(canvas.width, canvas.height, 1, capabilities.inputGeometry);
      if (geometry.preparedSize.width !== canvas.width || geometry.preparedSize.height !== canvas.height) throw new PicPatchSdkError('UNSUPPORTED_CAPABILITY', 'Outpaint canvas must not require model cropping or downscaling.');
    }
  }
  return request;
}

/** The shape the admission rules read: which inputs a request has, not the images themselves. */
export function admissionRequest(request: ImageRequest): AdmissionRequest {
  if ('prompt' in request) return { operation: 'generate', text: request.prompt, ...(request.parameters ? { parameters: request.parameters } : {}), ...(request.size ? { size: request.size } : {}), ...(request.control ? { control: request.control } : {}) };
  return { operation: 'edit', text: request.instruction, sourceImage: request.sourceImage !== undefined, maskImage: request.maskImage !== undefined,
    ...(request.outpaint ? { outpaint: request.outpaint } : {}), ...(request.parameters ? { parameters: request.parameters } : {}), ...(request.size ? { size: request.size } : {}), ...(request.control ? { control: request.control } : {}),
    references: (request.references ?? []).map(group => ({ id: group.id, role: group.role, ...(group.conditioning ? { conditioning: group.conditioning } : {}), ...(group.className !== undefined ? { className: group.className } : {}), images: group.images.length })) };
}
function refuseIssues(request: ImageRequest, capabilities: ModelCapabilities): void {
  const [first] = admissionIssues(admissionRequest(request), capabilities);
  if (first) throw new PicPatchSdkError('UNSUPPORTED_CAPABILITY', first.message);
}

export function validateGenerateRequest(input: unknown, capabilities?: ModelCapabilities): GenerateRequest {
  if (!generationValid(input)) throw new PicPatchSdkError('INVALID_REQUEST', 'Invalid generation request: check prompt, output, numeric bounds, and unknown fields.');
  const request = structuredClone(input);
  if (!isAbsolute(request.outputPath) || extname(request.outputPath).toLowerCase() !== '.png') {
    throw new PicPatchSdkError('INVALID_REQUEST', 'Output must be an absolute path with a .png extension.');
  }
  if (capabilities && !capabilitiesValid(capabilities)) throw new PicPatchSdkError('PROTOCOL_ERROR', 'Worker returned invalid model capabilities.');
  validateControl(request);
  if (capabilities) {
    if (capabilities.model !== request.model) throw new PicPatchSdkError('UNSUPPORTED_CAPABILITY', 'This model does not advertise text-to-image generation.');
    refuseIssues(request, capabilities);
  }
  return request;
}

function validateControl(request: ImageRequest): void {
  if (!request.control) return;
  if (!isAbsolute(request.control.image)) throw new PicPatchSdkError('INVALID_REQUEST', 'Control image paths must be absolute.');
  if (resolve(request.control.image) === resolve(request.outputPath)) throw new PicPatchSdkError('OUTPUT_CONFLICT', 'Output must not replace the control image.', { subject: request.outputPath });
}
