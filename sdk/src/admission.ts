// Whether a model accepts a request's shape: the SDK's own capability rules, dependency-free so a
// window can ask before calling (browser entry). Execution applies the same rules and stays the
// authority, since it also checks the images themselves.
import type { ImageSize, ModelCapabilities, OutpaintCanvas, ReferenceGroup, SamplingParameters, StructuralControl } from './contracts.generated.ts';

export const admissionCodes = [
  'GENERATION_UNSUPPORTED', 'GENERATION_INPUTS', 'EDITING_UNSUPPORTED', 'SOURCE_REQUIRED', 'MASK_REQUIRED', 'MASK_UNSUPPORTED',
  'OUTPAINT_UNSUPPORTED', 'REFERENCE_ROLE_UNSUPPORTED', 'REFERENCE_LIMIT', 'REFERENCE_CONDITIONING_UNSUPPORTED',
  'REFERENCE_IMAGES_REQUIRED', 'REFERENCE_CLASS_REQUIRED', 'REFERENCE_PLACEHOLDER', 'STRENGTH_REQUIRES_SOURCE',
  'PARAMETER_UNSUPPORTED', 'PARAMETER_OUT_OF_RANGE', 'SIZE_UNSUPPORTED', 'CONTROL_UNSUPPORTED',
] as const;
export type AdmissionCode = typeof admissionCodes[number];
/** One reason the model refuses the request; subject names the reference group or parameter it concerns. */
export interface AdmissionIssue { code: AdmissionCode; message: string; subject?: string }
/** A request's shape: which inputs it has, not the images themselves. */
export interface AdmissionRequest {
  operation: 'generate' | 'edit';
  /** The prompt or instruction; placeholder rules are checked only when it is given. */
  text?: string;
  sourceImage?: boolean;
  maskImage?: boolean;
  outpaint?: OutpaintCanvas;
  references?: { id: string; role: ReferenceGroup['role']; conditioning?: ReferenceGroup['conditioning']; className?: string; images: number }[];
  parameters?: SamplingParameters;
  size?: ImageSize;
  control?: Pick<StructuralControl, 'kind'>;
}

const sourceParameters = ['strength', 'identityStyleStrength', 'appearanceStrength'] as const;
/** The advertised defaults applied to a request's parameters, with what the model refuses. */
export function effectiveParameters(parameters: SamplingParameters = {}, capabilities: ModelCapabilities, operation: 'edit' | 'generate' = 'edit'): { effective: SamplingParameters; issues: AdmissionIssue[] } {
  const supported = capabilities.parameters ?? {};
  const effective: SamplingParameters = {};
  const issues: AdmissionIssue[] = [];
  const unsupported = (subject: string, code: AdmissionCode = 'PARAMETER_UNSUPPORTED') => issues.push({ code, message: 'The requested sampling parameters are unsupported by this model.', subject });
  for (const key of Object.keys(parameters) as (keyof SamplingParameters)[]) {
    if (!supported[key] || ((sourceParameters as readonly string[]).includes(key) && operation !== 'edit')) unsupported(key);
  }
  for (const key of ['steps', 'guidance', ...sourceParameters] as const) {
    const descriptor = supported[key];
    if (!descriptor || ((sourceParameters as readonly string[]).includes(key) && operation !== 'edit')) continue;
    const value = parameters[key] ?? descriptor.default;
    if (!Number.isFinite(value) || value < descriptor.minimum || (descriptor.maximum !== undefined && value > descriptor.maximum) || (descriptor.integer && !Number.isSafeInteger(value))) unsupported(key, 'PARAMETER_OUT_OF_RANGE');
    if (key === 'strength' && supported.strength?.minimumExclusive && value === descriptor.minimum) unsupported(key, 'PARAMETER_OUT_OF_RANGE');
    effective[key] = value;
  }
  for (const key of ['scheduler', 'sampler'] as const) {
    const descriptor = supported[key];
    if (!descriptor) continue;
    effective[key] = parameters[key] ?? descriptor.default;
    if (!descriptor.values.includes(effective[key])) unsupported(key, 'PARAMETER_OUT_OF_RANGE');
  }
  const negative = supported.negativePrompt;
  if (negative) {
    const value = parameters.negativePrompt ?? negative.default;
    if (value !== undefined) {
      if (negative.requiresGuidanceAbove !== undefined && !(effective.guidance !== undefined && effective.guidance > negative.requiresGuidanceAbove)) unsupported('negativePrompt', 'PARAMETER_OUT_OF_RANGE');
      effective.negativePrompt = value;
    } else if (negative.requiredForGuidanceAbove !== undefined && effective.guidance !== undefined && effective.guidance > negative.requiredForGuidanceAbove) unsupported('guidance', 'PARAMETER_OUT_OF_RANGE');
  }
  return { effective, issues };
}

export function sizeAccepted(size: ImageSize | undefined, capabilities: ModelCapabilities): boolean {
  const limits = capabilities.size;
  return !size || !limits || !(size.width % limits.widthMultiple !== 0 || size.height % limits.heightMultiple !== 0 ||
    (limits.minWidth !== undefined && size.width < limits.minWidth) || (limits.minHeight !== undefined && size.height < limits.minHeight) ||
    (limits.maxWidth !== undefined && size.width > limits.maxWidth) || (limits.maxHeight !== undefined && size.height > limits.maxHeight));
}

/** Every reason the model refuses this request, in the order execution checks them; empty when it is accepted. */
export function admissionIssues(request: AdmissionRequest, capabilities: ModelCapabilities): AdmissionIssue[] {
  const issues: AdmissionIssue[] = [];
  const issue = (code: AdmissionCode, message: string, subject?: string) => issues.push({ code, message, ...(subject === undefined ? {} : { subject }) });
  const groups = request.references ?? [];
  if (request.control && !capabilities.controlKinds?.includes(request.control.kind)) issue('CONTROL_UNSUPPORTED', 'This model does not support the requested structural control.');
  if (request.operation === 'generate') {
    if (capabilities.textToImage !== true) issue('GENERATION_UNSUPPORTED', 'This model does not advertise text-to-image generation.');
    if (request.sourceImage || request.maskImage || request.outpaint || groups.length) issue('GENERATION_INPUTS', 'Generation takes no source, mask, canvas or reference images; edit instead.');
    issues.push(...effectiveParameters(request.parameters, capabilities, 'generate').issues);
    if (!sizeAccepted(request.size, capabilities)) issue('SIZE_UNSUPPORTED', 'The requested dimensions are unsupported by this model.');
    return issues;
  }
  const images = groups.reduce((total, group) => total + group.images, 0);
  if (capabilities.sourceImageRequired && !request.sourceImage) issue('SOURCE_REQUIRED', 'This model requires a source image.');
  if (capabilities.maskRequired && !request.maskImage && !request.outpaint) issue('MASK_REQUIRED', 'This model requires a mask image.');
  if (!capabilities.instructionEditing) issue('EDITING_UNSUPPORTED', 'This model does not support instruction editing.');
  if (request.maskImage && capabilities.maskMode === 'none') issue('MASK_UNSUPPORTED', 'This model does not support masks.');
  for (const group of groups) {
    if (!capabilities.referenceRoles.includes(group.role)) issue('REFERENCE_ROLE_UNSUPPORTED', 'This model does not support a requested reference role.', group.id);
    if (group.images < 1) issue('REFERENCE_IMAGES_REQUIRED', 'Every reference group needs at least one image.', group.id);
  }
  if (capabilities.maxReferenceImages !== undefined && images > capabilities.maxReferenceImages) issue('REFERENCE_LIMIT', 'The reference count exceeds this model’s supported limit.');
  if (capabilities.maxConditioningImages !== undefined && images + (request.sourceImage ? 1 : 0) > capabilities.maxConditioningImages) issue('REFERENCE_LIMIT', 'The total source and reference count exceeds this model’s supported limit.');
  if (request.outpaint) {
    if (!capabilities.outpainting || capabilities.maskMode === 'none') issue('OUTPAINT_UNSUPPORTED', 'This model does not support outpainting.');
    if (!sizeAccepted(request.outpaint.size, capabilities)) issue('SIZE_UNSUPPORTED', 'The requested dimensions are unsupported by this model.');
  }
  const conditioning = capabilities.referenceConditioning;
  const inputs = request.sourceImage || request.maskImage || request.outpaint;
  if (conditioning === 'independent-subject') {
    if (inputs || groups.length < 1 || groups.length > 2) issue('REFERENCE_CONDITIONING_UNSUPPORTED', 'Independent subject binding requires one or two reference groups without a source or mask.');
    for (const group of groups) {
      if (/[{}]/.test(group.id) || group.images !== 1 || group.conditioning !== 'identity' || group.className !== undefined) issue('REFERENCE_CONDITIONING_UNSUPPORTED', 'Supply one image per identity group without className.', group.id);
      if (request.text !== undefined && !request.text.includes(`{${group.id}}`)) issue('REFERENCE_PLACEHOLDER', 'Mention each subject using its group placeholder.', group.id);
    }
    if (request.text !== undefined && /\[ref#[0-9]+\]/i.test(request.text)) issue('REFERENCE_PLACEHOLDER', 'Use group placeholders; the SDK supplies learned reference indices.');
  } else if (conditioning === 'pooled-identity' || conditioning === 'appearance-embedding') {
    if (inputs || groups.length !== 1) issue('REFERENCE_CONDITIONING_UNSUPPORTED', 'Dedicated reference conditioning requires exactly one group and no source or mask.');
    const group = groups[0];
    if (group && conditioning === 'pooled-identity') {
      if (group.conditioning !== 'identity') issue('REFERENCE_CONDITIONING_UNSUPPORTED', 'Identity conditioning requires an identity group and className.', group.id);
      else if (!group.className) issue('REFERENCE_CLASS_REQUIRED', 'Identity conditioning requires an identity group and className.', group.id);
      const placeholder = `{${group.id}}`;
      if (request.text !== undefined && (request.text.split(placeholder).length !== 2 || /\bimg\b/i.test(request.text.replace(placeholder, '')))) issue('REFERENCE_PLACEHOLDER', 'Use the identity group placeholder exactly once; the SDK supplies the native trigger word.', group.id);
    } else if (group && (group.conditioning !== 'appearance' || group.className)) issue('REFERENCE_CONDITIONING_UNSUPPORTED', 'Appearance conditioning requires an appearance group without an identity class.', group.id);
  } else {
    for (const group of groups) if ((group.conditioning !== undefined && group.conditioning !== 'prompt') || group.className !== undefined) issue('REFERENCE_CONDITIONING_UNSUPPORTED', 'This model supports prompt grouping, not dedicated identity or appearance conditioning.', group.id);
  }
  const { effective, issues: parameterIssues } = effectiveParameters(request.parameters, capabilities, 'edit');
  issues.push(...parameterIssues);
  if (effective.strength !== undefined && effective.strength < 1 && !request.sourceImage) issue('STRENGTH_REQUIRES_SOURCE', 'Source-strength control requires a source image.');
  if (!sizeAccepted(request.size, capabilities)) issue('SIZE_UNSUPPORTED', 'The requested dimensions are unsupported by this model.');
  return issues;
}
