import { preference, UiError } from '../../shared/i18n/index.ts';
import type { Language } from '../../shared/i18n/index.ts';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { validateProfile, validateModelRegistration } from 'picpatchsdk';
import type { ModelRegistration, PicPatchProfile } from 'picpatchsdk';
export interface Settings {
  version: 1; sessionsDirectory?: string; profile: PicPatchProfile; registrations: Record<string, ModelRegistration>; concurrency?: number; uiFont?: string; theme?: 'light' | 'dark'; language?: Language;
  /** An IANA zone; absent means System. */
  timeZone?: string;
}
import { writeJson } from './files.ts';
import { maxConcurrency } from '../../shared/session.ts';
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
  if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, profile: { version: 1 }, registrations: {} };
  throw unusable(path, error);
}
function settingsText(path: string, text: string): Settings {
  try { return parseSettings(JSON.parse(text)); }
  catch (error) { throw unusable(path, error); }
}
const unusable = (path: string, cause: unknown) => new UiError('startup.settingsFile', { path }, { cause });
function parseSettings(value: Settings): Settings {
  if (!value || typeof value !== 'object' || value.version !== 1 || (value.registrations !== undefined && (typeof value.registrations !== 'object' || value.registrations === null || Array.isArray(value.registrations)))) throw new Error('Unsupported settings format.');
  value.profile ??= { version: 1 }; value.registrations ??= {};
  if (value.theme !== undefined && !['light', 'dark'].includes(value.theme)) delete value.theme;
  value.language = preference(value.language);
  if (typeof value.uiFont !== 'string' || !value.uiFont.trim()) delete value.uiFont;
  if (value.timeZone !== undefined && !validTimeZone(value.timeZone)) delete value.timeZone;
  if (!validConcurrency(value.concurrency) || value.concurrency === 1) delete value.concurrency;
  // A resource profile from a newer PicPatch is a newer format like any other. A newer registration affects only its
  // own model: it stays as saved, and opening that model refuses it.
  if (validateProfile(value.profile).status === 'refused') throw new Error('Resource profile from a newer PicPatch.');
  for (const entry of Object.values(value.registrations)) validateModelRegistration(entry);
  if (value.sessionsDirectory !== undefined && !isAbsolute(value.sessionsDirectory)) throw new Error('Stored resource paths must be absolute.');
  return value;
}
/** The profile settings may hold; a newer one is never written. */
export function usableProfile(value: unknown): PicPatchProfile {
  const result = validateProfile(value);
  if (result.status === 'refused') throw new UiError('error.newer_format');
  return result.profile;
}
export async function saveSettings(path: string, value: Settings): Promise<Buffer> {
  usableProfile(value.profile);
  const stored: Record<string, unknown> = { ...structuredClone(value) };
  if (Object.keys(value.profile).length === 1) delete stored.profile;
  if (!Object.keys(value.registrations).length) delete stored.registrations;
  return writeJson(path, stored);
}
export const validConcurrency = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= maxConcurrency;
