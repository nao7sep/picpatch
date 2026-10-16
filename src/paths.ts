import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { PicPatchUsageError } from './errors.ts';

export interface StorageOptions {
  dataDirectory?: string;
  modelsDirectory?: string;
}
export interface StoragePaths {
  dataDirectory: string;
  modelsDirectory: string;
}

function configuredPath(value: unknown, home: string): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) {
    throw new PicPatchUsageError('INVALID_REQUEST', 'Storage locations must be nonempty filesystem paths.');
  }
  const expanded = value.replace(/\$([A-Za-z_][A-Za-z0-9_]*)|%([A-Za-z_][A-Za-z0-9_]*)%/g, (_match, unix: string | undefined, windows: string | undefined) => {
    const replacement = process.env[(unix ?? windows)!];
    if (!replacement) throw new PicPatchUsageError('INVALID_REQUEST', 'A storage location refers to an unset or empty environment variable.');
    return replacement;
  });
  if (expanded.includes('\0')) throw new PicPatchUsageError('INVALID_REQUEST', 'Storage locations must not contain null characters.');
  if (expanded === '~') return home;
  if (expanded.startsWith('~/') || expanded.startsWith('~\\')) return resolve(home, expanded.slice(2));
  if (expanded.startsWith('~')) throw new PicPatchUsageError('INVALID_REQUEST', 'Only the current user home shorthand is supported.');
  return resolve(home, expanded);
}

/** Resolve owned locations lazily, without creating, scanning or moving files. */
export function resolveStoragePaths(options: StorageOptions = {}): StoragePaths {
  if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => !['dataDirectory', 'modelsDirectory'].includes(key))) {
    throw new PicPatchUsageError('INVALID_REQUEST', 'Invalid storage options.');
  }
  for (const value of Object.values(options)) {
    if (value !== undefined && typeof value !== 'string') throw new PicPatchUsageError('INVALID_REQUEST', 'Storage locations must be strings.');
  }
  const home = homedir();
  const dataValue = options.dataDirectory ?? (process.env.PICPATCH_DATA_DIR || undefined);
  const modelsValue = options.modelsDirectory ?? (process.env.PICPATCH_MODELS_DIR || undefined);
  const dataDirectory = dataValue === undefined ? join(home, '.picpatch') : configuredPath(dataValue, home);
  const modelsDirectory = modelsValue === undefined ? join(dataDirectory, 'models') : configuredPath(modelsValue, home);
  return { dataDirectory, modelsDirectory };
}
