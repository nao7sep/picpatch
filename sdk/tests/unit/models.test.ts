import { mkdtemp, mkdir, writeFile, symlink, readdir, rm, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { inspectModel, discoverModels } from '../../src/index.ts';
let directory: string;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'picpatch-models-')); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
async function bundle(name: string) {
  const path = join(directory, name); await mkdir(path, { recursive: true });
  await writeFile(join(path, 'config.json'), '{invalid JSON is not executed or trusted');
  await writeFile(join(path, 'model.safetensors'), 'placeholder, not real weights');
  return path;
}
it('reports presence without claiming valid weights, config, compatibility, or identity', async () => {
  const path = await bundle('model');
  const result = await inspectModel(path);
  expect(result).toMatchObject({ path, status: 'unverified', integrity: 'not-verified', compatibility: 'unknown', issues: [] });
  expect(result.files.map(f => f.kind)).toEqual(['configuration', 'weights']);
  expect(await readdir(path)).toEqual(['config.json', 'model.safetensors']);
});
it('inspects a single weight file without loading it', async () => {
  const path = join(await bundle('model'), 'model.safetensors');
  expect(await inspectModel(path)).toMatchObject({ status: 'unverified', files: [{ path, kind: 'weights' }] });
});
it('reports empty, partial, and missing linked files', async () => {
  const path = await bundle('model');
  await writeFile(join(path, 'empty.gguf'), '');
  await writeFile(join(path, 'download.incomplete'), 'partial');
  await symlink(join(directory, 'missing'), join(path, 'missing.safetensors'));
  const result = await inspectModel(path);
  expect(result.status).toBe('incomplete');
  for (const issue of result.issues) expect(issue).toMatchObject({ message: expect.any(String), effect: 'none' });
  expect(result.issues.map(i => i.code).sort()).toEqual(['EMPTY_FILE', 'MISSING_FILE', 'PARTIAL_FILE']);
});
it('reads cached file links without changing their authored path', async () => {
  const path = join(directory, 'models--owner--model', 'snapshots', 'revision');
  await mkdir(path, { recursive: true });
  const blob = join(directory, 'blob'); await writeFile(blob, 'weight placeholder');
  const link = join(path, 'model.safetensors'); await symlink(blob, link);
  const found = await discoverModels([directory]);
  expect(found.models).toHaveLength(1);
  expect(found.models[0]!.files).toMatchObject([{ path: link, resolvedPath: await realpath(blob) }]);
});
it('keeps nested components in one bundle and discovers independent bundles', async () => {
  const a = await bundle('a'); const b = await bundle('b');
  await mkdir(join(a, 'transformer')); await writeFile(join(a, 'transformer', 'weights.safetensors'), 'x');
  const found = await discoverModels([directory]);
  expect(found.models.map(m => m.path)).toEqual([a, b]);
  expect(found.models[0]!.files).toHaveLength(3);
});
it('deduplicates repeated and symlinked roots', async () => {
  const path = await bundle('a'); const alias = join(directory, 'alias'); await symlink(path, alias);
  expect((await discoverModels([path, alias, path])).models).toHaveLength(1);
});
it('does not follow nested directory links or cycles', async () => {
  const path = await bundle('model'); await symlink(directory, join(path, 'cycle'));
  const found = await discoverModels([directory]); expect(found.models).toHaveLength(1);
  expect(found.models[0]!.issues).toEqual([{ path: join(path, 'cycle'), code: 'SKIPPED_DIRECTORY_LINK', message: 'A nested directory link was skipped.', effect: 'none' }]);
});
it('distinguishes an empty search from an unreadable root', async () => {
  expect(await discoverModels([directory])).toEqual({ models: [] });
  expect(await discoverModels([join(directory, 'missing')])).toMatchObject({ models: [], failures: [{ error: { code: 'FILE_NOT_FOUND', effect: 'none' } }] });
});
it('returns unrecognized for directories without weights', async () => {
  expect(await inspectModel(directory)).toMatchObject({ status: 'unrecognized', files: [] });
});
it.each(['relative', '', 'https://example.com/model'])('rejects invalid location %s', async path => {
  await expect(inspectModel(path)).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
});
it('validates discovery arguments and operation options', async () => {
  await expect(discoverModels([])).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  await expect(inspectModel(directory, { signal: 'invalid' } as never)).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
});
it('supports cancellation before reads and from progress', async () => {
  const controller = new AbortController(); controller.abort();
  await expect(inspectModel('/not-read', { signal: controller.signal })).rejects.toMatchObject({ code: 'CANCELLED' });
  const active = new AbortController();
  await expect(discoverModels([directory], { signal: active.signal, onEvent: () => active.abort() })).rejects.toMatchObject({ code: 'CANCELLED' });
});
it('continues inspection when progress callbacks fail', async () => {
  const cause = new Error('callback');
  await expect(inspectModel(directory, { onProgress: () => { throw cause; } })).resolves.toHaveProperty('files');
});

it('deduplicates components across overlapping roots regardless of input order', async () => {
  const path = await bundle('model'); const child = join(path, 'transformer');
  await mkdir(child); await writeFile(join(child, 'model.safetensors'), 'x');
  expect((await discoverModels([child, path])).models.map(m => m.path)).toEqual([path]);
});

it.each(['transformer', 'unet'])('groups a component-only %s bundle without a root configuration', async denoiser => {
  const root = join(directory, 'bundle');
  for (const component of [denoiser, 'text_encoder', 'vae']) {
    const path = join(root, component); await mkdir(path, { recursive: true });
    await writeFile(join(path, 'model.safetensors'), 'fixture');
  }
  const other = await bundle('other');
  const found = await discoverModels([directory, join(root, denoiser)]);
  expect(found.models.map(model => model.path)).toEqual([root, other]);
  expect(found.models[0]).toMatchObject({ status: 'unverified', integrity: 'not-verified', compatibility: 'unknown' });
  expect(found.models[0]!.files).toHaveLength(3);
});
it('does not follow linked components when recognizing a bundle layout', async () => {
  const root = join(directory, 'bundle'); await mkdir(root);
  const external = await bundle('external');
  await symlink(external, join(root, 'transformer'));
  await symlink(external, join(root, 'text_encoder'));
  expect(await discoverModels([root])).toEqual({ models: [] });
});
