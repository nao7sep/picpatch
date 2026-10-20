import type { ModelCapabilities, SamplingParameters } from './contracts.generated.ts';
import { effectiveParameters } from './admission.ts';
import { PicPatchSdkError } from './errors.ts';

/** Resolve advertised defaults and validate combinations before image I/O or loading. */
export function resolveParameters(parameters: SamplingParameters = {}, capabilities: ModelCapabilities, operation: 'edit' | 'generate' = 'edit'): SamplingParameters {
  const { effective, issues } = effectiveParameters(parameters, capabilities, operation);
  if (issues.length) throw new PicPatchSdkError('UNSUPPORTED_CAPABILITY', issues[0]!.message);
  return effective;
}
