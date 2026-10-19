import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { validateProfile, validateModelRegistration } from 'picpatchsdk';
import type { ModelRegistration, PicPatchProfile } from 'picpatchsdk';
export interface Settings { version: 1; sessionsDirectory?: string; profile: PicPatchProfile; registrations: Record<string, ModelRegistration>; uvExecutable?: string }
import { writeJson } from './files.ts';
export async function readSettings(path: string): Promise<Settings> {
  let value: Settings;
  try { value = JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, profile: { version: 1 }, registrations: {} }; throw error; }
  if (value.version !== 1 || !value.registrations || typeof value.registrations !== 'object' || Array.isArray(value.registrations)) throw new Error('Settings format is unsupported; the file was preserved.');
  validateProfile(value.profile);
  for (const entry of Object.values(value.registrations)) validateModelRegistration(entry);
  for (const path of [value.sessionsDirectory, value.uvExecutable]) if (path !== undefined && !isAbsolute(path)) throw new Error('Stored resource paths must be absolute.');
  return value;
}
export async function saveSettings(path: string, value: Settings): Promise<Buffer> { validateProfile(value.profile); return writeJson(path, value); }
