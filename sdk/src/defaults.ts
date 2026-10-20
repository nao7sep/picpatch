import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { absolutePath } from './operations.ts';
import { PicPatchSdkError } from './errors.ts';
import { validateEditRequest, validateGenerateRequest } from './validation.ts';
import { contractValidator } from './contracts.ts';
import type { SamplingParameters } from './contracts.generated.ts';
import type { GenerateRequest, EditRequest, ImageSize } from './types.ts';

export type { EditInput, GenerateInput, ImageDefaults } from './types.ts';
import type { EditInput, GenerateInput, ImageDefaults } from './types.ts';
const sizeValid = contractValidator<ImageSize>('ImageSize');
const parametersValid = contractValidator<SamplingParameters>('SamplingParameters');
function checkParameters(value: unknown): void {
  if (!parametersValid(value)) throw new PicPatchSdkError('INVALID_REQUEST', 'Invalid sampling parameters: check names and numeric bounds.');
}
export function validateDefaults(value: ImageDefaults = {}): ImageDefaults {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['size', 'seed', 'outputDirectory', 'parameters'].includes(key))) throw new PicPatchSdkError('INVALID_REQUEST', 'Invalid image defaults.');
  if (value.outputDirectory !== undefined) absolutePath(value.outputDirectory);
  if (value.size !== undefined && !sizeValid(value.size)) throw new PicPatchSdkError('INVALID_REQUEST', 'Invalid default size.');
  if (value.seed !== undefined && (!Number.isSafeInteger(value.seed) || value.seed < 0 || value.seed > 0xffff_ffff)) throw new PicPatchSdkError('INVALID_REQUEST', 'Invalid default seed.');
  if (value.parameters !== undefined) checkParameters(value.parameters);
  return structuredClone(value);
}
export function resolveEditRequest(input: EditInput, defaults: ImageDefaults, model?: string): EditRequest {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new PicPatchSdkError('INVALID_REQUEST', 'Supply an edit request.');
  if (input.model !== undefined && model !== undefined && input.model !== model) throw new PicPatchSdkError('UNSUPPORTED_CAPABILITY', 'The image client is configured for a different model.');
  if (input.outputDirectory !== undefined) absolutePath(input.outputDirectory);
  if (input.outputPath !== undefined && input.outputDirectory !== undefined) throw new PicPatchSdkError('INVALID_REQUEST', 'Supply outputPath or outputDirectory, not both.');
  const { outputDirectory, ...request } = input;
  let outputPath = input.outputPath;
  if (outputPath === undefined) {
    if (input.sourceImage !== undefined) absolutePath(input.sourceImage);
    const destination = outputDirectory ?? defaults.outputDirectory;
    if (!destination) throw new PicPatchSdkError('INVALID_REQUEST', 'Edits require an output path or directory.');
    outputPath = join(destination, `edit-${randomUUID()}.png`);
  }
  const { outputDirectory: _directory, ...settings } = defaults;
  return validateEditRequest({ ...settings, ...request,
    ...mergeParameters(settings.parameters, input.parameters),
    ...(input.size === undefined && settings.size !== undefined ? { size: settings.size } : {}),
    ...(input.seed === undefined && settings.seed !== undefined ? { seed: settings.seed } : {}),
    model: input.model === undefined ? model : input.model, outputPath });
}

export function resolveGenerateRequest(input: GenerateInput, defaults: ImageDefaults, model?: string): GenerateRequest {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new PicPatchSdkError('INVALID_REQUEST', 'Supply a generation request.');
  if (input.model !== undefined && model !== undefined && input.model !== model) throw new PicPatchSdkError('UNSUPPORTED_CAPABILITY', 'The image client is configured for a different model.');
  if (input.outputDirectory !== undefined) absolutePath(input.outputDirectory);
  if (input.outputPath !== undefined && input.outputDirectory !== undefined) throw new PicPatchSdkError('INVALID_REQUEST', 'Supply outputPath or outputDirectory, not both.');
  const { outputDirectory, ...request } = input;
  const destination = outputDirectory ?? defaults.outputDirectory;
  if (input.outputPath === undefined && !destination) throw new PicPatchSdkError('INVALID_REQUEST', 'Generation requires an output path or directory.');
  const { outputDirectory: _directory, ...settings } = defaults;
  return validateGenerateRequest({ ...settings, ...request,
    ...mergeParameters(settings.parameters, input.parameters),
    ...(input.size === undefined && settings.size !== undefined ? { size: settings.size } : {}),
    ...(input.seed === undefined && settings.seed !== undefined ? { seed: settings.seed } : {}),
    model: input.model === undefined ? model : input.model,
    outputPath: input.outputPath === undefined ? join(destination!, `generate-${randomUUID()}.png`) : input.outputPath });
}

function mergeParameters(defaults: SamplingParameters | undefined, overrides: SamplingParameters | undefined): { parameters?: SamplingParameters } {
  // Validate before spreading, which would otherwise conceal null/array/non-object inputs.
  if (overrides !== undefined) checkParameters(overrides);
  if (defaults === undefined && overrides === undefined) return {};
  return { parameters: { ...defaults, ...Object.fromEntries(Object.entries(overrides ?? {}).filter(([, value]) => value !== undefined)) } };
}
