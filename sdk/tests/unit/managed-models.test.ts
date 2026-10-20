import * as storage from '../../src/storage.ts';
import * as files from 'node:fs/promises';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { inspectModels, removeModel, discoverModels, listModels } from 'picpatchsdk';
let directory: string;
const id = listModels().find(model => model.acquisition === 'pinned')!.id;
const revision = 'a'.repeat(40);
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'picpatch-managed-')); });
afterEach(async () => { vi.restoreAllMocks(); await rm(directory, { recursive: true, force: true }); });
it('inventories old revisions and incomplete attempts, without traversing linked data', async () => {
  for (const name of [revision, '.prepare-abc', 'unrelated']) {
    await mkdir(join(directory, id, name), { recursive: true }); await writeFile(join(directory, id, name, 'weights'), 'data');
  }
  await symlink(join(directory, id, 'unrelated'), join(directory, id, revision, 'linked'));
  const inventory = await inspectModels({ modelsDirectory: directory });
  expect(inventory.entries.map(e => [e.name, e.kind, e.bytes])).toEqual([['.prepare-abc', 'incomplete', 4], [revision, 'revision', 4]]);
  expect(await removeModel(id, revision, { modelsDirectory: directory })).toMatchObject({ status: 'removed' });
  expect(await readFile(join(directory, id, 'unrelated', 'weights'), 'utf8')).toBe('data');
  expect(await removeModel(id, revision, { modelsDirectory: directory })).toMatchObject({ status: 'missing' });
  expect(await removeModel(id, '.prepare-abc', { modelsDirectory: directory })).toMatchObject({ status: 'removed' });
  expect(await readdir(join(directory, id))).toEqual(['unrelated']);
});
it('rejects external selections, traversal, directory links and cancelled removals', async () => {
  const external = join(directory, 'external'); await mkdir(external); await writeFile(join(external, 'keep'), 'keep');
  await mkdir(join(directory, id)); await symlink(external, join(directory, id, revision));
  await expect(removeModel(id, revision, { modelsDirectory: directory })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  for (const name of ['../external', 'external', '/absolute']) await expect(removeModel(id, name, { modelsDirectory: directory })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  await expect(removeModel('sdxl', revision, { modelsDirectory: directory })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  await expect(removeModel(id, revision, { modelsDirectory: directory, signal: AbortSignal.abort() })).rejects.toMatchObject({ code: 'CANCELLED' });
  expect(await readFile(join(external, 'keep'), 'utf8')).toBe('keep');
  await rm(join(directory, id), { recursive: true }); await symlink(external, join(directory, id));
  await expect(removeModel(id, revision, { modelsDirectory: directory })).rejects.toMatchObject({ code: 'MODEL_LINK_REFUSED' });
});
it('reports an inaccessible search root without discarding independently discovered models', async () => {
  await writeFile(join(directory, 'model.safetensors'), 'data');
  const result = await discoverModels([join(directory, 'missing'), directory]);
  expect(result.models).toHaveLength(1);
  expect(result.failures).toMatchObject([{ path: join(directory, 'missing'), error: { code: 'FILE_NOT_FOUND', effect: 'none' } }]);
});

it('does not remove a concurrently installed replacement at the original revision name', async () => {
  const original = join(directory, id, revision);
  await mkdir(original, { recursive: true }); await writeFile(join(original, 'old'), 'old');
  vi.spyOn(storage, 'rename').mockImplementation(async (from, to) => {
    await files.rename(from, to);
    await mkdir(original); await writeFile(join(original, 'new'), 'new');
  });
  expect(await removeModel(id, revision, { modelsDirectory: directory })).toMatchObject({ status: 'removed' });
  expect(await readdir(original)).toEqual(['new']);
});
it('reports retained recovery files when deletion fails after detaching a revision', async () => {
  const original = join(directory, id, revision);
  await mkdir(original, { recursive: true }); await writeFile(join(original, 'weights'), 'keep');
  vi.spyOn(storage, 'rm').mockRejectedValue(Object.assign(new Error('denied'), { code: 'EACCES' }));
  let failure: any;
  try { await removeModel(id, revision, { modelsDirectory: directory }); } catch (error) { failure = error; }
  expect(failure).toMatchObject({ code: 'MODEL_REMOVAL_INCOMPLETE', effect: 'unknown' });
  expect(await readFile(join(failure.details.recoveryDirectory, 'model', 'weights'), 'utf8')).toBe('keep');
  vi.restoreAllMocks();
  expect((await inspectModels({ modelsDirectory: directory })).entries).toMatchObject([{ kind: 'incomplete', bytes: 4 }]);
});
