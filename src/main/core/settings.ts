import { preference, UiError } from '../../shared/i18n/index.ts';
import type { Language } from '../../shared/i18n/index.ts';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { validateProfile, validateModelRegistration } from 'picpatchsdk';
import { appFile, checkFileHeader, fileContent } from './file-header.ts';
import type { ModelRegistration, PicPatchProfile } from 'picpatchsdk';
export interface Settings {
  sessionsDirectory?: string; profile: PicPatchProfile; registrations: Record<string, ModelRegistration>; modelsKeptLoaded?: number; uiFont?: string; theme?: 'light' | 'dark'; language?: Language;
  /** An IANA zone; absent means System. */
  timeZone?: string;
}
import { writeJson } from './files.ts';
import { maxModelsKeptLoaded } from '../../shared/session.ts';
import { validTimeZone } from '../../shared/time-zone.ts';
/**
 * Settings that cannot be used (unreadable, malformed or in a newer format) stop startup with the file's full path;
 * the file is never rewritten or moved, so the user decides what happens to it.
 */
export async function readSettings(path: string): Promise<Settings> {
  let text: string;
  try { text = await readFile(path, 'utf8'); }
  catch (error) { return settingsReadFailure(path, error); }
  return settingsText(path, text);
}
/** Startup captures one validated snapshot before Chromium and native language setup. */
export function readSettingsSync(path: string): Settings {
  let text: string;
  try { text = readFileSync(path, 'utf8'); }
  catch (error) { return settingsReadFailure(path, error); }
  return settingsText(path, text);
}
function settingsReadFailure(path: string, error: unknown): Settings {
  if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { profile: {}, registrations: {} };
  throw unusable(path, error);
}
function settingsText(path: string, text: string): Settings {
  try { return parseSettings(settingsContent(JSON.parse(text))); }
  catch (error) { throw unusable(path, error); }
}
const unusable = (path: string, cause: unknown) => new UiError('startup.settingsFile', { path }, { cause });
/** The settings under a config header; another format or a newer version is unusable like any other file. */
function settingsContent(value: unknown): Settings {
  const header = checkFileHeader(value, 'config');
  if (header.status !== 'current') throw new Error(header.status === 'newer' ? `Settings from a newer PicPatch (format ${header.version}).` : 'Not a PicPatch config file.');
  return fileContent<Settings>(value as object);
}
function parseSettings(value: Settings): Settings {
  if (!value || typeof value !== 'object' || (value.registrations !== undefined && (typeof value.registrations !== 'object' || value.registrations === null || Array.isArray(value.registrations)))) throw new Error('Unsupported settings format.');
  value.profile ??= {}; value.registrations ??= {};
  if (value.theme !== undefined && !['light', 'dark'].includes(value.theme)) delete value.theme;
  value.language = preference(value.language);
  if (typeof value.uiFont !== 'string' || !value.uiFont.trim()) delete value.uiFont;
  if (value.timeZone !== undefined && !validTimeZone(value.timeZone)) delete value.timeZone;
  if (!validModelsKeptLoaded(value.modelsKeptLoaded) || value.modelsKeptLoaded === 1) delete value.modelsKeptLoaded;
  validateProfile(value.profile);
  for (const entry of Object.values(value.registrations)) validateModelRegistration(entry);
  if (value.sessionsDirectory !== undefined && !isAbsolute(value.sessionsDirectory)) throw new Error('Stored resource paths must be absolute.');
  return value;
}
/** The profile settings may hold. */
export const usableProfile = (value: unknown): PicPatchProfile => validateProfile(value).profile;
export async function saveSettings(path: string, value: Settings): Promise<Buffer> {
  usableProfile(value.profile);
  const stored: Record<string, unknown> = { ...structuredClone(value) };
  if (!Object.keys(value.profile).length) delete stored.profile;
  if (!Object.keys(value.registrations).length) delete stored.registrations;
  return writeJson(path, appFile('config', stored));
}
export const validModelsKeptLoaded = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= maxModelsKeptLoaded;
