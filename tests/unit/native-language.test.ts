import { afterEach, expect, it, vi } from 'vitest';
const electron = vi.hoisted(() => ({ app: { isPackaged: true, getPreferredSystemLanguages: vi.fn(() => ['de-DE']), getSystemLocale: vi.fn(() => 'de-DE'), commandLine: { appendSwitch: vi.fn() } }, systemPreferences: { removeUserDefault: vi.fn(), setUserDefault: vi.fn() } }));
vi.mock('electron', () => electron);
const argv = [...process.argv];
afterEach(() => { process.argv = [...argv]; vi.clearAllMocks(); vi.resetModules(); electron.app.isPackaged = true; });
it.each(['--smoke','--smoke-localization','--smoke-inference'])('never writes native app defaults during %s qualification', async flag => {
  process.argv.push(flag);
  const { bootstrapLanguage, selectLanguage } = await import('../../src/main/language.ts');
  await bootstrapLanguage(undefined); await selectLanguage('ja');
  expect(electron.systemPreferences.removeUserDefault).not.toHaveBeenCalled(); expect(electron.systemPreferences.setUserDefault).not.toHaveBeenCalled();
});
it('settles captured language before native surfaces and resets System without touching shared Electron defaults', async () => {
  const { bootstrapLanguage, localeState, selectLanguage, prepareChromiumLanguage } = await import('../../src/main/language.ts');
  prepareChromiumLanguage('ja'); expect(electron.app.commandLine.appendSwitch).toHaveBeenCalledWith('lang', 'ja');
  await bootstrapLanguage('ja'); expect(localeState()).toEqual({ language: 'ja', format: 'ja', systemLanguage: 'de' });
  if (process.platform === 'darwin') expect(electron.systemPreferences.setUserDefault).toHaveBeenCalledWith('AppleLanguages', 'array', ['ja']);
  await selectLanguage(undefined); expect(localeState().language).toBe('de');
  vi.resetModules(); vi.clearAllMocks(); electron.app.isPackaged = false;
  await (await import('../../src/main/language.ts')).bootstrapLanguage('ja');
  expect(electron.systemPreferences.removeUserDefault).not.toHaveBeenCalled(); expect(electron.systemPreferences.setUserDefault).not.toHaveBeenCalled();
});
it('leaves Chromium language automatic without a captured choice', async () => {
  const { prepareChromiumLanguage } = await import('../../src/main/language.ts');
  prepareChromiumLanguage(undefined);
  expect(electron.app.commandLine.appendSwitch).not.toHaveBeenCalled();
});
it('maps the captured Simplified Chinese choice to Chromium’s locale name', async () => {
  const { prepareChromiumLanguage } = await import('../../src/main/language.ts');
  prepareChromiumLanguage('zh-Hans');
  expect(electron.app.commandLine.appendSwitch).toHaveBeenCalledWith('lang', 'zh-CN');
});
