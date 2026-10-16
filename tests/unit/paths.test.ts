import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { discoverModels, resolveStoragePaths } from '../../src/index.ts';

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'picpatch-paths-'));
  vi.stubEnv('HOME', directory);
  vi.stubEnv('PICPATCH_DATA_DIR', '');
  vi.stubEnv('PICPATCH_MODELS_DIR', '');
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); });

it('resolves lazily without creating directories, and uses the home API', async () => {
  expect(resolveStoragePaths()).toEqual({ dataDirectory: join(homedir(), '.picpatch'), modelsDirectory: join(homedir(), '.picpatch', 'models') });
  vi.stubEnv('PICPATCH_DATA_DIR', join(directory, 'new'));
  expect(resolveStoragePaths().modelsDirectory).toBe(join(directory, 'new', 'models'));
  expect(await discoverModels()).toEqual({ models: [] });
  expect(await readdir(directory)).toEqual([]);
});
it('honors explicit options before environment and derives defaults from the selected root', () => {
  vi.stubEnv('PICPATCH_DATA_DIR', 'data');
  vi.stubEnv('PICPATCH_MODELS_DIR', 'weights');
  expect(resolveStoragePaths()).toEqual({ dataDirectory: join(homedir(), 'data'), modelsDirectory: join(homedir(), 'weights') });
  expect(resolveStoragePaths({ dataDirectory: 'custom', modelsDirectory: '~/chosen' })).toEqual({ dataDirectory: join(homedir(), 'custom'), modelsDirectory: join(homedir(), 'chosen') });
  vi.stubEnv('PICPATCH_MODELS_DIR', '');
  expect(resolveStoragePaths({ dataDirectory: 'custom' }).modelsDirectory).toBe(join(homedir(), 'custom', 'models'));
});
it('expands environment references once and preserves literal explicit discovery roots', async () => {
  vi.stubEnv('PICPATCH_PATH_TEST', directory);
  vi.stubEnv('PICPATCH_DATA_DIR', '$PICPATCH_PATH_TEST/data');
  vi.stubEnv('PICPATCH_MODELS_DIR', '%PICPATCH_PATH_TEST%/weights');
  expect(resolveStoragePaths()).toEqual({ dataDirectory: join(directory, 'data'), modelsDirectory: join(directory, 'weights') });
  const literal = join(directory, '$PICPATCH_PATH_TEST');
  await mkdir(literal); await writeFile(join(literal, 'weights.gguf'), 'fixture');
  expect((await discoverModels([literal])).models[0]?.path).toBe(literal);
});
it('discovers only the configured model root and does not move files on relocation', async () => {
  const models = join(directory, 'models'); await mkdir(models);
  await writeFile(join(models, 'weights.gguf'), 'fixture');
  vi.stubEnv('PICPATCH_MODELS_DIR', models);
  expect((await discoverModels()).models[0]?.path).toBe(models);
  vi.stubEnv('PICPATCH_MODELS_DIR', join(directory, 'elsewhere'));
  expect(await discoverModels()).toEqual({ models: [] });
  expect(await readdir(models)).toEqual(['weights.gguf']);
});
it('does not treat a broken configured directory link as an empty cache', async () => {
  const link = join(directory, 'broken'); await symlink(join(directory, 'absent'), link);
  vi.stubEnv('PICPATCH_MODELS_DIR', link);
  await expect(discoverModels()).rejects.toMatchObject({ code: 'MODEL_IO' });
});
it.each([null, [], { unknown: true }, { dataDirectory: null }, { modelsDirectory: '' }, { dataDirectory: '~other/data' }, { dataDirectory: '\0' }])('rejects invalid storage options %j', options => {
  expect(() => resolveStoragePaths(options as never)).toThrow(expect.objectContaining({ code: 'INVALID_REQUEST' }));
});
it('rejects unset expansion variables rather than falling back elsewhere', () => {
  vi.stubEnv('PICPATCH_PATH_TEST', ''); vi.stubEnv('PICPATCH_DATA_DIR', '$PICPATCH_PATH_TEST/data');
  expect(() => resolveStoragePaths()).toThrow(expect.objectContaining({ code: 'INVALID_REQUEST' }));
});

it('does not expand expressions again in derived paths', () => {
  vi.stubEnv('PICPATCH_PATH_TEST', join(directory, '$LITERAL'));
  vi.stubEnv('PICPATCH_DATA_DIR', '$PICPATCH_PATH_TEST');
  vi.stubEnv('LITERAL', 'must-not-expand');
  expect(resolveStoragePaths().modelsDirectory).toBe(join(directory, '$LITERAL', 'models'));
});
