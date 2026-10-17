import type { ModelCapabilities, SamplingParameters } from './contracts.generated.ts';
import { PicPatchUsageError } from './errors.ts';

/** Resolve advertised defaults and validate combinations before image I/O or loading. */
export function resolveParameters(parameters: SamplingParameters = {}, capabilities: ModelCapabilities): SamplingParameters {
  const supported = capabilities.parameters ?? {};
  const effective: SamplingParameters = {};
  const unsupported = (): never => { throw new PicPatchUsageError('UNSUPPORTED_CAPABILITY', 'The requested sampling parameters are unsupported by this model.'); };
  for (const key of Object.keys(parameters) as (keyof SamplingParameters)[]) if (!supported[key]) unsupported();
  for (const key of ['steps', 'guidance'] as const) {
    const descriptor = supported[key];
    if (!descriptor) continue;
    const value = parameters[key] ?? descriptor.default;
    if (!Number.isFinite(value) || value < descriptor.minimum || (descriptor.maximum !== undefined && value > descriptor.maximum) || (descriptor.integer && !Number.isSafeInteger(value))) unsupported();
    effective[key] = value;
  }
  if (supported.scheduler) {
    effective.scheduler = parameters.scheduler ?? supported.scheduler.default;
    if (!supported.scheduler.values.includes(effective.scheduler)) unsupported();
  }
  const negative = supported.negativePrompt;
  if (negative) {
    const value = parameters.negativePrompt ?? negative.default;
    if (value !== undefined) {
      if (negative.requiresGuidanceAbove !== undefined && !(effective.guidance !== undefined && effective.guidance > negative.requiresGuidanceAbove)) unsupported();
      effective.negativePrompt = value;
    } else if (negative.requiredForGuidanceAbove !== undefined && effective.guidance !== undefined && effective.guidance > negative.requiredForGuidanceAbove) unsupported();
  }
  return effective;
}
