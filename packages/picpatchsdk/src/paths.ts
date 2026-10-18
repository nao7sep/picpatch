import { homedir } from 'node:os';
import { join } from 'node:path';
import { absolutePath } from './operations.ts';
import { PicPatchUsageError } from './errors.ts';

export interface StorageOptions {
  engineDirectory?: string;
  modelsDirectory?: string;
}
export interface StoragePaths {
  engineDirectory: string;
  modelsDirectory: string;
}

/** Only SDK resources have defaults. Caller paths are absolute and literal. No I/O. */
export function resolveStoragePaths(options: StorageOptions = {}): StoragePaths {
  if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => !['engineDirectory', 'modelsDirectory'].includes(key))) {
    throw new PicPatchUsageError('INVALID_REQUEST', 'Invalid storage options.');
  }
  for (const value of Object.values(options)) if (value !== undefined) absolutePath(value);
  const root = options.engineDirectory === undefined || options.modelsDirectory === undefined ? join(homedir(), '.picpatchsdk') : undefined;
  return {
    engineDirectory: options.engineDirectory ?? join(root!, 'engine'),
    modelsDirectory: options.modelsDirectory ?? join(root!, 'models'),
  };
}
