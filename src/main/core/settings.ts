import { preference, UiError } from '../../shared/i18n/index.ts';
import type { Language } from '../../shared/i18n/index.ts';
import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { validateProfile, validateModelRegistration } from 'picpatchsdk';
import type { ModelRegistration, PicPatchProfile } from 'picpatchsdk';
export interface Settings { version: 1; sessionsDirectory?: string; profile: PicPatchProfile; registrations: Record<string, ModelRegistration>; concurrency?: number; uiFont?: string; theme?: 'light' | 'dark'; language?: Language }
import { writeJson } from './files.ts';
export async function readSettings(path: string): Promise<Settings> {
  let value: Settings;
  try { value = JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, profile: { version: 1 }, registrations: {} }; throw error; }
  if (value.version !== 1 || (value.registrations !== undefined && (typeof value.registrations !== 'object' || value.registrations === null || Array.isArray(value.registrations)))) throw new UiError('error.settings_format_is_unsupported_the_file_was_preserved');
  value.profile ??= { version: 1 }; value.registrations ??= {};
  if (value.theme !== undefined && !['light', 'dark'].includes(value.theme)) delete value.theme;
  value.language = preference(value.language);
  if (typeof value.uiFont !== 'string' || !value.uiFont.trim()) delete value.uiFont;
  if (!validConcurrency(value.concurrency) || value.concurrency === 1) delete value.concurrency;
  validateProfile(value.profile);
  for (const entry of Object.values(value.registrations)) validateModelRegistration(entry);
  delete (value as { uvExecutable?: unknown }).uvExecutable; // Retired: the bundled uv is always used.
  if (value.sessionsDirectory !== undefined && !isAbsolute(value.sessionsDirectory)) throw new UiError('error.stored_resource_paths_must_be_absolute');
  return value;
}
export async function saveSettings(path: string, value: Settings): Promise<Buffer> { validateProfile(value.profile); const stored: Partial<Settings> = structuredClone(value); if (Object.keys(value.profile).length === 1) delete stored.profile; if (!Object.keys(value.registrations).length) delete stored.registrations; return writeJson(path, stored); }
/** How many images may generate at once; 1 unless the user's machine has memory for several models. */
export const maxConcurrency = 8;
export const validConcurrency = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= maxConcurrency;
