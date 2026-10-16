import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { absolutePath } from './operations.ts';
import { PicPatchUsageError } from './errors.ts';
import { validateEditRequest } from './validation.ts';
import type { EditRequest, ImageSize } from './types.ts';

export type EditInput = Omit<EditRequest, 'model' | 'outputPath'> & { model?: string; outputPath?: string; outputDirectory?: string };
export interface EditDefaults { size?: ImageSize; seed?: number; outputDirectory?: string }
export function validateDefaults(value: EditDefaults = {}): EditDefaults {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['size', 'seed', 'outputDirectory'].includes(key))) throw new PicPatchUsageError('INVALID_REQUEST', 'Invalid editor defaults.');
  if (value.outputDirectory !== undefined) absolutePath(value.outputDirectory);
  validateEditRequest({ model: 'validation', instruction: 'Validate defaults', sourceImage: '/source.png', outputPath: '/output.png',
    ...(value.size !== undefined ? { size: value.size } : {}), ...(value.seed !== undefined ? { seed: value.seed } : {}) });
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
    const destination = outputDirectory ?? defaults.outputDirectory ?? (input.sourceImage ? dirname(input.sourceImage) : undefined);
    if (!destination) throw new PicPatchUsageError('INVALID_REQUEST', 'Reference-only edits require an output path or directory.');
    outputPath = join(destination, `edit-${randomUUID()}.png`);
  }
  const { outputDirectory: _directory, ...settings } = defaults;
  return validateEditRequest({ ...settings, ...request,
    ...(input.size === undefined && settings.size !== undefined ? { size: settings.size } : {}),
    ...(input.seed === undefined && settings.seed !== undefined ? { seed: settings.seed } : {}),
    model: input.model === undefined ? model : input.model, outputPath });
}
