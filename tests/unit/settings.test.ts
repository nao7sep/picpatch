import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { readSettings, saveSettings } from '../../src/main/core/settings.ts';
import { Application } from '../../src/main/core/service.ts';
let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'picpatch-settings-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
it('keeps defaults absent and preserves explicit resource choices when resetting presentation', async () => {
  const path = join(root, 'config.json'); const defaults = await readSettings(path);
  await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
  await saveSettings(path, defaults); expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ version: 1 });
  const settings = { ...defaults, profile: { version: 1 as const, modelsDirectory: join(root, 'models') }, theme: 'dark' as const };
  await saveSettings(path, settings); expect(await readSettings(path)).toEqual(settings);
  delete (settings as { theme?: string }).theme;
  await saveSettings(path, settings); expect((await readSettings(path)).profile.modelsDirectory).toBe(join(root, 'models'));
});
it('leaves unsupported settings untouched and rejects relative resource paths before publication', async () => {
  const config = join(root, 'config.json'); await writeFile(config, '{"version":99}');
  // A newer format and malformed content both name the file and its full path, and leave it as it was.
  await expect(readSettings(config)).rejects.toMatchObject({ notice: { key: 'startup.settingsFile', values: { path: config } } }); expect(await readFile(config, 'utf8')).toBe('{"version":99}');
  await writeFile(config, '{"version":1,'); await expect(readSettings(config)).rejects.toThrow(config); expect(await readFile(config, 'utf8')).toBe('{"version":1,');
  await writeFile(config, '{"version":1,"sessionsDirectory":"relative"}'); await expect(readSettings(config)).rejects.toThrow('config.json');
  await rm(config);
  const app = await Application.open({ root, config, sessions: join(root, 'sessions'), state: join(root, 'state.json'), backups: join(root, 'backups.sqlite3') });
  await expect(app.preferences({ modelsDirectory: 'relative' })).rejects.toMatchObject({ kind: 'invalid' });
  expect(app.settings.profile).toEqual({ version: 1 }); await expect(readFile(config)).rejects.toMatchObject({ code: 'ENOENT' });
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
  app.queue.state.active = [{ sessionId: 'session', runId: 'run', stage: 'preparing', startedAt: Date.now() }];
  await app.preferences({ modelsDirectory: join(root,'models'), theme: 'dark', language: 'ja', uiFont: 'Arial' });
  expect(app.settings).toMatchObject({ theme: 'dark', language: 'ja', uiFont: 'Arial' });
  await expect(app.preferences({ modelsDirectory: join(root,'other') })).rejects.toThrow();
});
it('reads a missing or unknown theme as System', async () => {
  const config = join(root, 'config.json');
  await writeFile(config, JSON.stringify({ version: 1, theme: 'sepia' })); expect((await readSettings(config)).theme).toBeUndefined();
  await writeFile(config, JSON.stringify({ version: 1 })); expect((await readSettings(config)).theme).toBeUndefined();
});
it('stores Images at once only when it differs from 1 and ignores an invalid stored value', async () => {
  const config = join(root, 'config.json');
  const app = await Application.open({ root, config, sessions: join(root, 'sessions'), state: join(root, 'state.json'), backups: join(root, 'backups.sqlite3') });
  await app.preferences({ concurrency: 3 }); expect(JSON.parse(await readFile(config, 'utf8')).concurrency).toBe(3);
  await expect(app.preferences({ concurrency: 0 })).rejects.toThrow();
  await app.preferences({}); expect(JSON.parse(await readFile(config, 'utf8')).concurrency).toBeUndefined();
  await writeFile(config, JSON.stringify({ version: 1, concurrency: 99 })); expect((await readSettings(config)).concurrency).toBeUndefined();
});
it('keeps a newer profile or registration as saved while the rest of the settings stay usable', async () => {
  const config = join(root, 'config.json');
  const newerProfile = { version: 2, futureField: true };
  const newerRegistration = { version: 3, model: { future: true } };
  await writeFile(config, JSON.stringify({ version: 1, theme: 'dark', profile: newerProfile, registrations: { future: newerRegistration } }));
  const settings = await readSettings(config);
  // Only the newer items are set aside: the theme still applies, and resources fall back to the defaults.
  expect(settings).toMatchObject({ theme: 'dark', profile: { version: 1 }, newerProfile, registrations: { future: newerRegistration } });
  const app = await Application.open({ root, config, sessions: join(root, 'sessions'), state: join(root, 'state.json'), backups: join(root, 'backups.sqlite3') });
  await app.preferences({ theme: 'light' });
  expect(JSON.parse(await readFile(config, 'utf8'))).toMatchObject({ theme: 'light', profile: newerProfile, registrations: { future: newerRegistration } });
  // Choosing resources replaces the newer profile; the registration stays until that model is prepared again.
  await app.preferences({ modelsDirectory: join(root, 'models') });
  expect(JSON.parse(await readFile(config, 'utf8'))).toMatchObject({ profile: { version: 1, modelsDirectory: join(root, 'models') }, registrations: { future: newerRegistration } });
});

it('round-trips literal selected resource paths without expanding or trimming them', async () => {
  const config = join(root, 'config.json');
  const app = await Application.open({ root, config, sessions: join(root, 'sessions'), state: join(root, 'state.json'), backups: join(root, 'backups.sqlite3') });
  const resources = { engineDirectory: join(root, '$HOME', 'engine '), modelsDirectory: join(root, '%MODELS%', 'models '), nativeExecutable: join(root, 'sd-cli ') };
  await app.preferences(resources);
  expect((await readSettings(config)).profile).toEqual({ version: 1, ...resources });
  expect((await app.overview()).locations).toMatchObject({ engineDirectory: resources.engineDirectory, modelsDirectory: resources.modelsDirectory });
  expect((await app.overview()).resourceDefaults).toEqual({ engineDirectory: join(homedir(), '.picpatchsdk', 'engine'), modelsDirectory: join(homedir(), '.picpatchsdk', 'models') });
});
