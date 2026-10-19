import { app, systemPreferences } from 'electron';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { preference, resolveLocale, useLocale } from '../shared/i18n/index.ts';
import type { Locale } from '../shared/i18n/index.ts';
// Qualification uses disposable files, but macOS defaults would otherwise still target the real app domain.
const writesNativePreference = process.platform === 'darwin' && app.isPackaged && !process.argv.some(argument => argument === '--smoke' || argument.startsWith('--smoke-'));
let system: string[] = [];
let region = 'en';
let current: Locale = { language: 'en', format: 'en' };
export function localeState() { return { ...current, systemLanguage: resolveLocale(undefined, system, region).language }; }
export async function bootstrapLanguage(config: string) {
  let choice: unknown;
  try { choice = JSON.parse(await readFile(config, 'utf8')).language; } catch { /* The settings owner reports corruption; locale bootstrap stays usable. */ }
  if (writesNativePreference) {
    try { systemPreferences.removeUserDefault('AppleLanguages'); } catch (error) { console.error('Could not clear app language preference.', error); }
  }
  system = app.getPreferredSystemLanguages(); region = app.getSystemLocale();
  await selectLanguage(choice);
}
export async function selectLanguage(choice: unknown) {
  current = resolveLocale(choice, system, region); await useLocale(current);
  if (writesNativePreference) {
    try { if (preference(choice)) systemPreferences.setUserDefault('AppleLanguages', 'array', [current.language]); else systemPreferences.removeUserDefault('AppleLanguages'); }
    catch (error) { console.error('Could not save app language preference.', error); }
  }
}

export function prepareChromiumLanguage(config: string) {
  try {
    const choice = preference(JSON.parse(readFileSync(config, 'utf8')).language);
    if (choice) app.commandLine.appendSwitch('lang', choice === 'zh-Hans' ? 'zh-CN' : choice);
  } catch { /* Corrupt settings are reported after language bootstrap. */ }
}
