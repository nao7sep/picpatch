import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
const electron = vi.hoisted(() => ({ app: { isPackaged: true, getPreferredSystemLanguages: vi.fn(() => ['de-DE']), getSystemLocale: vi.fn(() => 'de-DE'), commandLine: { appendSwitch: vi.fn() } }, systemPreferences: { removeUserDefault: vi.fn(), setUserDefault: vi.fn() } }));
vi.mock('electron', () => electron);
const argv = [...process.argv];
afterEach(() => { process.argv = [...argv]; vi.clearAllMocks(); vi.resetModules(); electron.app.isPackaged = true; });
it.each(['--smoke','--smoke-localization','--smoke-inference'])('never writes native app defaults during %s qualification', async flag => {
  process.argv.push(flag);
  const { bootstrapLanguage, selectLanguage } = await import('../../src/desktop/language.ts');
  await bootstrapLanguage('/missing/picpatch-config.json'); await selectLanguage('ja');
  expect(electron.systemPreferences.removeUserDefault).not.toHaveBeenCalled(); expect(electron.systemPreferences.setUserDefault).not.toHaveBeenCalled();
});
it('settles saved language before native surfaces and resets System without touching shared Electron defaults', async () => {
  const directory = await mkdtemp(join(tmpdir(),'picpatch-language-')); const path = join(directory,'config.json');
  try {
    await writeFile(path, JSON.stringify({language:'ja'}));
    const { bootstrapLanguage, localeState, selectLanguage, prepareChromiumLanguage } = await import('../../src/desktop/language.ts');
    prepareChromiumLanguage(path); expect(electron.app.commandLine.appendSwitch).toHaveBeenCalledWith('lang','ja');
    await bootstrapLanguage(path); expect(localeState()).toEqual({language:'ja',format:'ja',systemLanguage:'de'});
    if (process.platform === 'darwin') expect(electron.systemPreferences.setUserDefault).toHaveBeenCalledWith('AppleLanguages','array',['ja']);
    await selectLanguage(undefined); expect(localeState().language).toBe('de');
    vi.resetModules(); vi.clearAllMocks(); electron.app.isPackaged = false;
    await (await import('../../src/desktop/language.ts')).bootstrapLanguage(path);
    expect(electron.systemPreferences.removeUserDefault).not.toHaveBeenCalled(); expect(electron.systemPreferences.setUserDefault).not.toHaveBeenCalled();
  } finally { await rm(directory,{recursive:true,force:true}); }
});
