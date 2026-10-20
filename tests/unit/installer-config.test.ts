import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { languages } from '../../src/shared/i18n/index.ts';
// A Windows checkout may have CRLF line endings.
const config = readFileSync(new URL('../../electron-builder.yml', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const scripts: Record<string, string> = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).scripts;
/** The indented body of one top-level section of electron-builder.yml. */
const section = (name: string) => new RegExp(`^${name}:\\n((?:[ #].*\\n|\\n)*)`, 'm').exec(config)?.[1] ?? '';
function listUnder(key: string): string[] {
  const lines = config.split('\n'); const start = lines.findIndex(line => line.trim() === `${key}:`);
  expect(start, key).toBeGreaterThanOrEqual(0);
  const items: string[] = [];
  for (const line of lines.slice(start + 1)) { const match = /^\s+- (\S+)$/.exec(line); if (!match) break; items.push(match[1]!); }
  return items;
}
it('excludes source maps and TypeScript declarations and ships the app, Electron and Chromium licences', () => {
  for (const exclusion of ['!**/*.map', '!**/*.d.ts', '!**/*.d.mts', '!**/*.d.cts']) expect(config).toContain(`  - "${exclusion}"`);
  for (const line of ['  - from: LICENSE\n    to: LICENSE.txt', '  - from: THIRD_PARTY_NOTICES\n    to: THIRD_PARTY_NOTICES', '  - from: node_modules/electron/dist/LICENSE\n    to: electron/LICENSE', '  - from: node_modules/electron/dist/LICENSES.chromium.html\n    to: electron/LICENSES.chromium.html']) expect(config).toContain(line);
});
it('prepares the bundled tools and Electron before every builder invocation', () => {
  for (const script of Object.values(scripts)) if (script.includes('electron-builder --publish')) {
    expect(script.indexOf('npm run prepare:tools')).toBeGreaterThanOrEqual(0); expect(script.indexOf('npm run prepare:electron')).toBeLessThan(script.indexOf('electron-builder'));
  }
});
it('uses the assisted per-user NSIS contract and the release artifact names', () => {
  for (const setting of ['oneClick: false', 'perMachine: false', 'allowElevation: true', 'createDesktopShortcut: true', 'createStartMenuShortcut: true', 'runAfterFinish: true']) expect(section('nsis')).toContain(`  ${setting}`);
  expect(section('mac')).toContain('  artifactName: ${productName}-${version}-mac.${ext}');
  expect(section('dmg')).toContain('  artifactName: ${productName}-${version}.${ext}');
  expect(section('win')).toContain('  artifactName: ${productName}-${version}-win.${ext}');
  expect(section('nsis')).toContain('  artifactName: ${productName}-${version}-setup.${ext}');
});
it('declares the interface languages in the macOS bundle and the installer, English first', () => {
  const tags = languages.map(([tag]) => tag).sort();
  const bundle = listUnder('CFBundleLocalizations'); expect(bundle[0]).toBe('en'); expect([...bundle].sort()).toEqual(tags);
  const installer = listUnder('installerLanguages'); expect(installer[0]).toBe('en_US');
  expect(installer.map(code => code === 'pt_BR' ? 'pt-BR' : code === 'zh_CN' ? 'zh-Hans' : code.split('_')[0]).sort()).toEqual(tags);
});
