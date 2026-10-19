import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { readSettings, saveSettings } from '../../src/app/settings.ts';
import { Application } from '../../src/app/service.ts';
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
  await expect(readSettings(config)).rejects.toThrow('unsupported'); expect(await readFile(config, 'utf8')).toBe('{"version":99}');
  await rm(config);
  const app = await Application.open({ root, config, sessions: join(root, 'sessions'), state: join(root, 'state.json'), backups: join(root, 'backups.sqlite3') });
  await expect(app.preferences({ modelsDirectory: 'relative' })).rejects.toMatchObject({ kind: 'invalid' });
  expect(app.settings.profile).toEqual({ version: 1 }); await expect(readFile(config)).rejects.toMatchObject({ code: 'ENOENT' });
});
