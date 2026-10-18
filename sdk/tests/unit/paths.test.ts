import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { discoverModels, resolveStoragePaths } from '../../src/index.ts';
import { resolveEditRequest } from '../../src/defaults.ts';
let directory: string;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'picpatchsdk-paths-')); vi.stubEnv('HOME', directory); });
afterEach(async () => { vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); });
it('defaults only SDK resources without creating directories or reading app overrides', async () => {
  vi.stubEnv('PICPATCH_DATA_DIR', '/ignored'); vi.stubEnv('PICPATCH_MODELS_DIR', '/ignored');
  expect(resolveStoragePaths()).toEqual({ engineDirectory: join(homedir(), '.picpatchsdk/engine'), modelsDirectory: join(homedir(), '.picpatchsdk/models') });
  expect(await discoverModels()).toEqual({ models: [] });
  expect(await readdir(directory)).toEqual([]);
});
it('keeps explicit roots independent, literal and usable side by side', async () => {
  const first = join(directory, '$LITERAL'); const second = join(directory, '%LITERAL%');
  vi.stubEnv('LITERAL', 'must-not-expand');
  for (const path of [first, second]) { await mkdir(path); await writeFile(join(path, 'weights.gguf'), 'fixture'); }
  expect(resolveStoragePaths({ modelsDirectory: first }).modelsDirectory).toBe(first);
  expect(resolveStoragePaths({ engineDirectory: second }).engineDirectory).toBe(second);
  expect((await discoverModels([first])).models[0]?.path).toBe(first);
  expect((await discoverModels([second])).models[0]?.path).toBe(second);
});
it('does not treat a broken explicit directory link as an empty cache', async () => {
  const path = join(directory, 'broken'); await symlink(join(directory, 'absent'), path);
  expect(await discoverModels([path])).toMatchObject({ models: [], failures: [{ path, error: { code: 'FILE_NOT_FOUND' } }] });
});
it.each([null, [], { unknown: true }, { engineDirectory: null }, { modelsDirectory: '' }, { modelsDirectory: 'relative' }, { modelsDirectory: '~/models' }, { engineDirectory: '\0' }])('rejects invalid resource locations %j', options => {
  expect(() => resolveStoragePaths(options as never)).toThrow(expect.objectContaining({ code: 'INVALID_REQUEST' }));
});
it('never invents a consumer output location beside a source', () => {
  expect(() => resolveEditRequest({ instruction: 'Edit', sourceImage: '/published/source.png' }, {}, 'model')).toThrow(expect.objectContaining({ code: 'INVALID_REQUEST' }));
  expect(resolveEditRequest({ instruction: 'Edit', sourceImage: '/published/source.png' }, { outputDirectory: directory }, 'model').outputPath).toContain(directory);
});
