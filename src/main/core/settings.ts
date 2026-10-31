import { preference } from '../../shared/i18n/index.ts';
import type { Language } from '../../shared/i18n/index.ts';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { validateProfile, validateModelRegistration } from 'picpatchsdk';
import { appFile, checkBeforeWrite, checkFileHeader, fileContent } from './file-header.ts';
import { refused } from './refused-files.ts';
import type { ModelRegistration, PicPatchProfile } from 'picpatchsdk';
export interface Settings {
  sessionsDirectory?: string; profile: PicPatchProfile; registrations: Record<string, ModelRegistration>; modelsKeptLoaded?: number; uiFont?: string; theme?: 'light' | 'dark'; language?: Language;
  /** An IANA zone; absent means System. */
  timeZone?: string;
  /** Saved values this build cannot use, written back as they were unless a save sets the same setting (config-sets-conventions). */
  unread?: Record<string, unknown>;
}
import { writeJson } from './files.ts';
import { maxModelsKeptLoaded } from '../../shared/session.ts';
import { validTimeZone } from '../../shared/time-zone.ts';
/**
 * Settings that cannot be used (unreadable, malformed or in a newer format) are refused by the file's full path, which
 * stops startup; the file is never rewritten or moved, so the user decides what happens to it.
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
  throw refused(path, false, error);
}
function settingsText(path: string, text: string): Settings {
  let document: unknown;
  try { document = JSON.parse(text); } catch (error) { throw refused(path, false, error); }
  const header = checkFileHeader(document, 'config');
  if (header.status !== 'current') throw refused(path, header.status === 'newer');
  try { return parseSettings(fileContent<Settings>(document as object)); }
  catch (error) { throw refused(path, false, error); }
}
function parseSettings(value: Settings): Settings {
  if (!value || typeof value !== 'object' || (value.registrations !== undefined && (typeof value.registrations !== 'object' || value.registrations === null || Array.isArray(value.registrations)))) throw new Error('Unsupported settings format.');
  value.profile ??= {}; value.registrations ??= {};
  // A presentation value this build cannot use falls back for this session and is kept for the file.
  const unread: Record<string, unknown> = {};
  const set = value as unknown as Record<string, unknown>;
  const fallBack = (key: keyof Settings, usable: boolean) => { if (set[key] !== undefined && !usable) { unread[key] = set[key]; delete set[key]; } };
  delete value.unread;
  fallBack('theme', ['light', 'dark'].includes(value.theme as string));
  fallBack('language', preference(value.language) !== undefined);
  fallBack('uiFont', typeof value.uiFont === 'string' && !!value.uiFont.trim());
  fallBack('timeZone', validTimeZone(value.timeZone));
  fallBack('modelsKeptLoaded', validModelsKeptLoaded(value.modelsKeptLoaded));
  if (value.modelsKeptLoaded === 1) delete value.modelsKeptLoaded;
  if (Object.keys(unread).length) value.unread = unread;
  validateProfile(value.profile);
  for (const entry of Object.values(value.registrations)) validateModelRegistration(entry);
  if (value.sessionsDirectory !== undefined && !isAbsolute(value.sessionsDirectory)) throw new Error('Stored resource paths must be absolute.');
  return value;
}
/** The profile settings may hold. */
export const usableProfile = (value: unknown): PicPatchProfile => validateProfile(value).profile;
export async function saveSettings(path: string, value: Settings): Promise<Buffer> {
  usableProfile(value.profile);
  const { unread, ...settings } = structuredClone(value);
  const stored: Record<string, unknown> = { ...unread, ...settings };
  if (!Object.keys(value.profile).length) delete stored.profile;
  if (!Object.keys(value.registrations).length) delete stored.registrations;
  // A config.json that is no longer this build's own (another program replaced it) is refused, not overwritten.
  await checkBeforeWrite(path, 'config');
  return writeJson(path, appFile('config', stored));
}
export const validModelsKeptLoaded = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= maxModelsKeptLoaded;
