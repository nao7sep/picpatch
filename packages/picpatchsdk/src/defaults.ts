import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { absolutePath } from './operations.ts';
import { PicPatchUsageError } from './errors.ts';
import { validateEditRequest, validateGenerateRequest } from './validation.ts';
import type { SamplingParameters } from './contracts.generated.ts';
import type { GenerateRequest, EditRequest, ImageSize } from './types.ts';

export type GenerateInput = Omit<GenerateRequest, 'model' | 'outputPath'> & { model?: string; outputPath?: string; outputDirectory?: string };
export type EditInput = Omit<EditRequest, 'model' | 'outputPath'> & { model?: string; outputPath?: string; outputDirectory?: string };
export interface EditDefaults { size?: ImageSize; seed?: number; outputDirectory?: string; parameters?: SamplingParameters }
export function validateDefaults(value: EditDefaults = {}): EditDefaults {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['size', 'seed', 'outputDirectory', 'parameters'].includes(key))) throw new PicPatchUsageError('INVALID_REQUEST', 'Invalid editor defaults.');
  if (value.outputDirectory !== undefined) absolutePath(value.outputDirectory);
  validateEditRequest({ model: 'validation', instruction: 'Validate defaults', sourceImage: '/source.png', outputPath: '/output.png',
    ...(value.parameters !== undefined ? { parameters: value.parameters } : {}), ...(value.size !== undefined ? { size: value.size } : {}), ...(value.seed !== undefined ? { seed: value.seed } : {}) });
  return structuredClone(value);
}
export function resolveEditRequest(input: EditInput, defaults: EditDefaults, model?: string): EditRequest {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new PicPatchUsageError('INVALID_REQUEST', 'Supply an edit request.');
  if (input.model !== undefined && model !== undefined && input.model !== model) throw new PicPatchUsageError('UNSUPPORTED_CAPABILITY', 'The editor is configured for a different model.');
  if (input.outputDirectory !== undefined) absolutePath(input.outputDirectory);
  if (input.outputPath !== undefined && input.outputDirectory !== undefined) throw new PicPatchUsageError('INVALID_REQUEST', 'Supply outputPath or outputDirectory, not both.');
  const { outputDirectory, ...request } = input;
  let outputPath = input.outputPath;
  if (outputPath === undefined) {
    if (input.sourceImage !== undefined) absolutePath(input.sourceImage);
    const destination = outputDirectory ?? defaults.outputDirectory;
    if (!destination) throw new PicPatchUsageError('INVALID_REQUEST', 'Edits require an output path or directory.');
    outputPath = join(destination, `edit-${randomUUID()}.png`);
  }
  const { outputDirectory: _directory, ...settings } = defaults;
  return validateEditRequest({ ...settings, ...request,
    ...mergeParameters(settings.parameters, input.parameters),
    ...(input.size === undefined && settings.size !== undefined ? { size: settings.size } : {}),
    ...(input.seed === undefined && settings.seed !== undefined ? { seed: settings.seed } : {}),
    model: input.model === undefined ? model : input.model, outputPath });
}

export function resolveGenerateRequest(input: GenerateInput, defaults: EditDefaults, model?: string): GenerateRequest {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new PicPatchUsageError('INVALID_REQUEST', 'Supply a generation request.');
  if (input.model !== undefined && model !== undefined && input.model !== model) throw new PicPatchUsageError('UNSUPPORTED_CAPABILITY', 'The editor is configured for a different model.');
  if (input.outputDirectory !== undefined) absolutePath(input.outputDirectory);
  if (input.outputPath !== undefined && input.outputDirectory !== undefined) throw new PicPatchUsageError('INVALID_REQUEST', 'Supply outputPath or outputDirectory, not both.');
  const { outputDirectory, ...request } = input;
  const destination = outputDirectory ?? defaults.outputDirectory;
  if (input.outputPath === undefined && !destination) throw new PicPatchUsageError('INVALID_REQUEST', 'Generation requires an output path or directory.');
  const { outputDirectory: _directory, ...settings } = defaults;
  return validateGenerateRequest({ ...settings, ...request,
    ...mergeParameters(settings.parameters, input.parameters),
    ...(input.size === undefined && settings.size !== undefined ? { size: settings.size } : {}),
    ...(input.seed === undefined && settings.seed !== undefined ? { seed: settings.seed } : {}),
    model: input.model === undefined ? model : input.model,
    outputPath: input.outputPath === undefined ? join(destination!, `generate-${randomUUID()}.png`) : input.outputPath });
}

function mergeParameters(defaults: SamplingParameters | undefined, overrides: SamplingParameters | undefined): { parameters?: SamplingParameters } {
  if (overrides !== undefined) {
    // Validate before spreading, which would otherwise conceal null/array/non-object inputs.
    validateGenerateRequest({ model: 'validation', prompt: 'Validate parameters', outputPath: '/output.png', parameters: overrides });
  }
  if (defaults === undefined && overrides === undefined) return {};
  return { parameters: { ...defaults, ...Object.fromEntries(Object.entries(overrides ?? {}).filter(([, value]) => value !== undefined)) } };
}
