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
function preparationProblems(script: string): string[] {
  const builders = [...script.matchAll(/\belectron-builder\b/g)];
  return builders.flatMap(builder => ['npm run prepare:tools', 'npm run prepare:electron'].filter(command => {
    const index = script.indexOf(command);
    return index < 0 || index >= builder.index;
  }));
}
it('prepares the bundled tools and Electron before every builder invocation', () => {
  const builders = Object.values(scripts).filter(script => script.includes('electron-builder'));
  expect(builders.length).toBeGreaterThan(0);
  for (const script of builders) expect(preparationProblems(script), script).toEqual([]);
});
it.each(['tools', 'electron'])('rejects missing and late %s preparation', tool => {
  const command = `npm run prepare:${tool}`;
  const other = tool === 'tools' ? 'electron' : 'tools';
  const prefix = `npm run prepare:${other} && `;
  expect(preparationProblems(`${prefix}electron-builder --publish never`)).toContain(command);
  expect(preparationProblems(`${prefix}electron-builder --publish never && ${command}`)).toContain(command);
  expect(preparationProblems(`${prefix}${command} && electron-builder --publish never`)).toEqual([]);
  expect(preparationProblems(`electron-builder --publish never && ${prefix}${command} && electron-builder --publish never`)).toContain(command);
});
it('requires only the installer produced by each isolated release runner, plus its portable', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/release.yml', import.meta.url), 'utf8');
  const build = workflow.slice(workflow.indexOf('  build:'));
  const matrix = [...build.matchAll(/- os: ([^\n]+)\n\s+installer: ([^\n]+)/g)].map(([, os, installer]) => [os, installer]);
  expect(matrix).toEqual([['macos-latest', 'dist/*.dmg'], ['windows-latest', 'dist/*.exe']]);
  const files = /files: \|\n((?: +[^\n]+\n?)*)/.exec(build)?.[1]?.trim().split('\n').map(line => line.trim());
  expect(files).toEqual(['${{ matrix.installer }}', 'dist/*.zip']);
  expect(build).toMatch(/fail_on_unmatched_files: true/);
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
