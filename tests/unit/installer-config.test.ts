import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { languages } from '../../src/shared/i18n/index.ts';
const config = readFileSync(new URL('../../electron-builder.yml', import.meta.url), 'utf8');
const scripts: Record<string, string> = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).scripts;
/** The indented body of one top-level section of electron-builder.yml. */
const section = (name: string) => new RegExp(`^${name}:\\n((?:[ #].*\\n|\\n)*)`, 'm').exec(config)?.[1] ?? '';
function listUnder(key: string, within = config): string[] {
  const lines = within.split('\n'); const start = lines.findIndex(line => line.trim() === `${key}:`);
  expect(start, key).toBeGreaterThanOrEqual(0);
  const items: string[] = [];
  for (const line of lines.slice(start + 1)) { const match = /^\s+- (\S+)$/.exec(line); if (!match) break; items.push(match[1]!); }
  return items;
}
it('prepares the bundled tools and Electron before every builder invocation', () => {
  for (const script of Object.values(scripts)) if (script.includes('electron-builder --publish')) {
    expect(script.indexOf('npm run prepare:tools')).toBeGreaterThanOrEqual(0); expect(script.indexOf('npm run prepare:electron')).toBeLessThan(script.indexOf('electron-builder'));
  }
});
it('declares the interface languages in the macOS bundle, both Electron locale sets and the installer, English first', () => {
  const tags = languages.map(([tag]) => tag).sort();
  // Electron names locales by Chromium's pak files: underscores on macOS, hyphens on Windows, and Simplified Chinese as zh_CN or zh-CN.
  const electron = (code: string) => code.replace('_', '-').replace(/^zh-CN$/, 'zh-Hans').replace(/^en-US$/, 'en');
  for (const platform of ['mac', 'win']) { const list = listUnder('electronLanguages', section(platform)); expect(electron(list[0]!), platform).toBe('en'); expect(list.map(electron).sort(), platform).toEqual(tags); }
  const bundle = listUnder('CFBundleLocalizations'); expect(bundle[0]).toBe('en'); expect([...bundle].sort()).toEqual(tags);
  const installer = listUnder('installerLanguages'); expect(installer[0]).toBe('en_US');
  expect(installer.map(code => code === 'pt_BR' ? 'pt-BR' : code === 'zh_CN' ? 'zh-Hans' : code.split('_')[0]).sort()).toEqual(tags);
});
