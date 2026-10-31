import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { readSettings, readSettingsSync, saveSettings } from '../../src/main/core/settings.ts';
import { Application } from '../../src/main/core/service.ts';
let root: string;
const header = { format: { owner: 'picpatch', kind: 'config', version: 1 }, writer: { name: 'picpatch', version: '1.0.0' } };
const configFile = (content: object = {}) => JSON.stringify({ ...header, ...content });
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'picpatch-settings-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
it('keeps defaults absent and preserves explicit resource choices when resetting presentation', async () => {
  const path = join(root, 'config.json'); const defaults = await readSettings(path);
  await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
  await saveSettings(path, defaults); expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(header);
  const settings = { ...defaults, profile: { modelsDirectory: join(root, 'models') }, theme: 'dark' as const };
  await saveSettings(path, settings); expect(await readSettings(path)).toEqual(settings);
  delete (settings as { theme?: string }).theme;
  await saveSettings(path, settings); expect((await readSettings(path)).profile.modelsDirectory).toBe(join(root, 'models'));
});
it('leaves unsupported settings untouched and rejects relative resource paths before publication', async () => {
  const config = join(root, 'config.json'); const newer = configFile({ format: { owner: 'picpatch', kind: 'config', version: 2 } });
  await writeFile(config, newer);
  // A newer format and malformed content both name the file and its full path, and leave it as it was.
  await expect(readSettings(config)).rejects.toMatchObject({ notice: { key: 'startup.settingsFile', values: { path: config } } }); expect(await readFile(config, 'utf8')).toBe(newer);
  await writeFile(config, '{"format":'); await expect(readSettings(config)).rejects.toThrow(config); expect(await readFile(config, 'utf8')).toBe('{"format":');
  await writeFile(config, configFile({ sessionsDirectory: 'relative' })); await expect(readSettings(config)).rejects.toThrow('config.json');
  await rm(config);
  const app = await Application.open({ root, config, sessions: join(root, 'sessions'), state: join(root, 'state.json'), backups: join(root, 'backups.sqlite3') });
  await expect(app.preferences({ modelsDirectory: 'relative' })).rejects.toMatchObject({ kind: 'invalid' });
  expect(app.settings.profile).toEqual({}); await expect(readFile(config)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('keeps SDK resource homes separate from the app collection and honors explicit overrides', async () => {
  const app = await Application.open({ root, config: join(root, 'config.json'), sessions: join(root, 'sessions'), state: join(root, 'state.json'), backups: join(root, 'backups.sqlite3') });
  expect((await app.overview()).locations).toMatchObject({ engineDirectory: join(homedir(), '.picpatchsdk', 'engine'), modelsDirectory: join(homedir(), '.picpatchsdk', 'models'), sessionsDirectory: join(root, 'sessions') });
  await app.preferences({ engineDirectory: join(root, 'custom-engine'), modelsDirectory: join(root, 'custom-models') });
  expect((await app.overview()).locations).toMatchObject({ engineDirectory: join(root, 'custom-engine'), modelsDirectory: join(root, 'custom-models'), sessionsDirectory: join(root, 'sessions') });
});
it('stores the UI family verbatim and clears only that preference for an empty family', async () => {
  const config = join(root, 'config.json');
  const app = await Application.open({ root, config, sessions: join(root,'sessions'), state: join(root,'state.json'), backups: join(root,'backups.sqlite3') });
  const family = ' "Missing Font", Arial, sans-serif ';
  await app.preferences({ uiFont: family, modelsDirectory: join(root,'models') });
  expect((await readSettings(config)).uiFont).toBe(family);
  await app.preferences({ uiFont: '', modelsDirectory: join(root,'models') });
  expect((await readSettings(config)).uiFont).toBeUndefined();
  expect((await readSettings(config)).profile.modelsDirectory).toBe(join(root,'models'));
});
it('saves appearance during work but refuses resource changes', async () => {
  const app = await Application.open({ root, config: join(root,'config.json'), sessions: join(root,'sessions'), state: join(root,'state.json'), backups: join(root,'backups.sqlite3') });
  await app.preferences({ modelsDirectory: join(root,'models') });
  app.queue.state.active = { sessionId: 'session', runId: 'run', stage: 'preparing', startedAt: Date.now() };
  await app.preferences({ modelsDirectory: join(root,'models'), theme: 'dark', language: 'ja', uiFont: 'Arial' });
  expect(app.settings).toMatchObject({ theme: 'dark', language: 'ja', uiFont: 'Arial' });
  await expect(app.preferences({ modelsDirectory: join(root,'other') })).rejects.toThrow();
});
it('reads a missing or unknown theme as System', async () => {
  const config = join(root, 'config.json');
  await writeFile(config, configFile({ theme: 'sepia' })); expect((await readSettings(config)).theme).toBeUndefined();
  await writeFile(config, configFile()); expect((await readSettings(config)).theme).toBeUndefined();
});
it('stores Models kept loaded only when it differs from 1 and ignores an invalid stored value', async () => {
  const config = join(root, 'config.json');
  const app = await Application.open({ root, config, sessions: join(root, 'sessions'), state: join(root, 'state.json'), backups: join(root, 'backups.sqlite3') });
  await app.preferences({ modelsKeptLoaded: 3 }); expect(JSON.parse(await readFile(config, 'utf8')).modelsKeptLoaded).toBe(3);
  await expect(app.preferences({ modelsKeptLoaded: 0 })).rejects.toThrow();
  await app.preferences({}); expect(JSON.parse(await readFile(config, 'utf8')).modelsKeptLoaded).toBeUndefined();
  await writeFile(config, configFile({ modelsKeptLoaded: 99 })); expect((await readSettings(config)).modelsKeptLoaded).toBeUndefined();
});
it('reads config.json by its header alone: another owner or kind, a missing header and a newer version stop startup untouched, and the writer is ignored', async () => {
  const config = join(root, 'config.json');
  for (const contents of [
    configFile({ format: { owner: 'pixelup', kind: 'config', version: 1 } }), configFile({ format: { owner: 'picpatch', kind: 'state', version: 1 } }),
    JSON.stringify({ theme: 'dark' }), JSON.stringify({ version: 1, theme: 'dark' }), configFile({ format: { owner: 'picpatch', kind: 'config', version: '1' } }),
    configFile({ format: { owner: 'picpatch', kind: 'config', version: 2 }, theme: 'dark' }),
  ]) {
    await writeFile(config, contents);
    await expect(readSettings(config)).rejects.toMatchObject({ notice: { key: 'startup.settingsFile', values: { path: config } } });
    expect(await readFile(config, 'utf8')).toBe(contents);
  }
  for (const writer of [undefined, 'garbage', { name: 'someone else', version: 7 }]) {
    await writeFile(config, JSON.stringify({ format: header.format, ...(writer === undefined ? {} : { writer }), theme: 'dark' }));
    expect((await readSettings(config)).theme).toBe('dark');
  }
  const app = await Application.open({ root, config, sessions: join(root, 'sessions'), state: join(root, 'state.json'), backups: join(root, 'backups.sqlite3') });
  await app.preferences({ theme: 'light' });
  const saved = JSON.parse(await readFile(config, 'utf8'));
  expect(Object.keys(saved).slice(0, 2)).toEqual(['format', 'writer']);
  expect(saved).toMatchObject({ ...header, theme: 'light' });
});

it('round-trips literal selected resource paths without expanding or trimming them', async () => {
  const config = join(root, 'config.json');
  const app = await Application.open({ root, config, sessions: join(root, 'sessions'), state: join(root, 'state.json'), backups: join(root, 'backups.sqlite3') });
  const resources = { engineDirectory: join(root, '$HOME', 'engine '), modelsDirectory: join(root, '%MODELS%', 'models '), nativeExecutable: join(root, 'sd-cli ') };
  await app.preferences(resources);
  expect((await readSettings(config)).profile).toEqual({ ...resources });
  expect((await app.overview()).locations).toMatchObject({ engineDirectory: resources.engineDirectory, modelsDirectory: resources.modelsDirectory });
  expect((await app.overview()).resourceDefaults).toEqual({ engineDirectory: join(homedir(), '.picpatchsdk', 'engine'), modelsDirectory: join(homedir(), '.picpatchsdk', 'models') });
});

it('keeps a known display time zone, drops an unknown one on read and refuses it on save', async () => {
  const config = join(root, 'config.json');
  await writeFile(config, configFile({ timeZone: 'Asia/Tokyo' })); expect((await readSettings(config)).timeZone).toBe('Asia/Tokyo');
  await writeFile(config, configFile({ timeZone: 'Mars/Olympus' })); expect((await readSettings(config)).timeZone).toBeUndefined();
  await rm(config);
  const app = await Application.open({ root, config, sessions: join(root, 'sessions'), state: join(root, 'state.json'), backups: join(root, 'backups.sqlite3') });
  await app.preferences({ timeZone: 'Europe/Berlin' }); expect(JSON.parse(await readFile(config, 'utf8')).timeZone).toBe('Europe/Berlin');
  await expect(app.preferences({ timeZone: 'Mars/Olympus' })).rejects.toThrow('This time zone is not known.');
  // System is the absence of a choice.
  await app.preferences({}); expect(JSON.parse(await readFile(config, 'utf8')).timeZone).toBeUndefined();
});

it('captures missing settings synchronously without creating the file', async () => {
  const config = join(root, 'config.json');
  expect(readSettingsSync(config)).toEqual(await readSettings(config));
  expect(readSettingsSync(config)).toEqual({ profile: {}, registrations: {} });
  await expect(readFile(config)).rejects.toMatchObject({ code: 'ENOENT' });
});
it('uses the same validation for the synchronous startup snapshot and later asynchronous reads', async () => {
  const config = join(root, 'config.json');
  await writeFile(config, configFile({ language: 'ja', theme: 'dark', timeZone: 'Asia/Tokyo', modelsKeptLoaded: 99 }));
  const captured = readSettingsSync(config);
  expect(captured).toEqual(await readSettings(config));
  expect(captured).toMatchObject({ language: 'ja', theme: 'dark', timeZone: 'Asia/Tokyo' });
  expect(captured.modelsKeptLoaded).toBeUndefined();
  await writeFile(config, configFile({ language: 'de' }));
  expect(captured.language).toBe('ja');
  expect((await readSettings(config)).language).toBe('de');
});
it.each(['{"format":', configFile({ format: { owner: 'picpatch', kind: 'config', version: 99 }, language: 'ja' }), configFile({ profile: { version: 1 } })])('rejects unusable synchronous startup settings and preserves their bytes: %s', async contents => {
  const config = join(root, 'config.json'); await writeFile(config, contents);
  let syncError: unknown; try { readSettingsSync(config); } catch (error) { syncError = error; }
  expect(syncError).toMatchObject({ notice: { key: 'startup.settingsFile', values: { path: config } }, cause: expect.any(Error) });
  await expect(readSettings(config)).rejects.toMatchObject({ notice: { key: 'startup.settingsFile', values: { path: config } } });
  expect(await readFile(config, 'utf8')).toBe(contents);
});
it('reports synchronous storage read failures instead of fabricating defaults', () => {
  expect(() => readSettingsSync(root)).toThrow(root);
});
