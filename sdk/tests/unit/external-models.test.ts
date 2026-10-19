import { mkdtemp, mkdir, writeFile, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { listModels, prepareModel, verifyModel } from '../../src/index.ts';

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'picpatch-external-'));
  for (const name of ['transformer', 'vae', 'text_encoder', 'text_encoder_2', 'tokenizer', 'tokenizer_2', 'processor', 'mllm', 'connector', 'mlp', 'unconditional_transformer']) {
    await mkdir(join(directory, name));
    if (['transformer', 'vae', 'text_encoder', 'unconditional_transformer'].includes(name)) await writeFile(join(directory, name, 'config.json'), '{}');
    if (name === 'tokenizer') await writeFile(join(directory, name, 'tokenizer_config.json'), '{}');
    if (name === 'mllm') {
      for (const filename of ['tokenizer.json', 'tokenizer_config.json', 'vocab.json', 'merges.txt']) await writeFile(join(directory, name, filename), '{}');
    }
    if (name === 'processor') {
      await writeFile(join(directory, name, 'tokenizer_config.json'), '{}');
      await writeFile(join(directory, name, 'preprocessor_config.json'), '{}');
    }
    await writeFile(join(directory, name, (name.startsWith('tokenizer') || name === 'processor') ? 'tokenizer.json' : '0.safetensors'), 'fixture');
  }
});
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

it.each(listModels().filter(model => model.acquisition === 'external' && model.runtime.name === 'mflux').map(model => model.id))('prepares %s with no handwritten manifest or bundle writes', async id => {
  const before = await readdir(directory, { recursive: true });
  const prepared = await prepareModel(id, { directory });
  expect(prepared).toMatchObject({ origin: 'external', integrity: 'locally-fingerprinted', model: { variant: id, directory, manifest: { model: id, source: { repository: 'local' } } } });
  expect((await verifyModel(directory, prepared.model.manifest)).status).toBe('matches-manifest');
  expect((await prepareModel(id, { directory })).model.manifest).toEqual(prepared.model.manifest);
  expect(await readdir(directory, { recursive: true })).toEqual(before);
  await writeFile(join(directory, 'transformer/0.safetensors'), 'changed');
  expect((await prepareModel(id, { directory })).model.manifest.source.revision).not.toBe(prepared.model.manifest.source.revision);
});
it('rejects unavailable acquisition, missing selection and incomplete component bundles', async () => {
  await expect(prepareModel('flux2-klein-9b', { download: true })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  await expect(prepareModel('flux2-klein-9b')).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  await expect(prepareModel('flux3-klein', { directory })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  await rm(join(directory, 'vae/0.safetensors'));
  await expect(prepareModel('flux2-klein-9b', { directory })).rejects.toMatchObject({ code: 'MODEL_IO' });
});
it('rejects invalid shard indexes instead of fingerprinting an incomplete bundle', async () => {
  await writeFile(join(directory, 'transformer/model.safetensors.index.json'), JSON.stringify({ weight_map: { weight: 'missing.safetensors' } }));
  await expect(prepareModel('flux2-klein-4b', { directory })).rejects.toMatchObject({ code: 'MODEL_IO' });
});
it('cancels fingerprinting at progress without writing into the bundle', async () => {
  const before = await readdir(directory, { recursive: true });
  const controller = new AbortController();
  await expect(prepareModel('flux2-klein-4b', { directory, signal: controller.signal, onEvent: () => controller.abort() })).rejects.toMatchObject({ code: 'CANCELLED' });
  expect(await readdir(directory, { recursive: true })).toEqual(before);
});
it('rejects directory links and special paths, while accepting HF-style file links', async () => {
  await rm(join(directory, 'vae/0.safetensors'));
  await symlink(join(directory, 'transformer/0.safetensors'), join(directory, 'vae/0.safetensors'));
  await expect(prepareModel('flux2-klein-4b', { directory })).resolves.toMatchObject({ integrity: 'locally-fingerprinted' });
  await symlink(join(directory, 'transformer'), join(directory, 'vae/nested'));
  await expect(prepareModel('flux2-klein-4b', { directory })).rejects.toMatchObject({ code: 'MODEL_IO' });
});

it.each(['processor/preprocessor_config.json', 'processor/tokenizer.json', 'text_encoder/config.json', 'vae/config.json', 'transformer/config.json'])('rejects incomplete Qwen 2.1 bundles missing %s', async path => {
  await rm(join(directory, path));
  await expect(prepareModel('qwen-image-2.1', { directory })).rejects.toMatchObject({ code: 'MODEL_IO' });
});
it('includes processor assets as tokenizer data without requiring processor weights', async () => {
  const prepared = await prepareModel('qwen-image-2.1', { directory });
  const processor = prepared.model.manifest.components.filter(component => component.path.startsWith('processor/'));
  expect(processor).toHaveLength(3);
  expect(processor.every(component => component.role === 'tokenizer')).toBe(true);
});

it('does not advertise Turbo without checkpoint-specific scheduler support', async () => {
  expect(listModels().some(model => model.id === 'qwen-image-2.1-turbo')).toBe(false);
  await expect(prepareModel('qwen-image-2.1-turbo', { directory })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
});

it.each([
  ['ideogram4-fp8', 'unconditional_transformer/0.safetensors'],
  ['ideogram4-fp8', 'unconditional_transformer/config.json'],
  ['ideogram4-fp8', 'tokenizer/tokenizer_config.json'],
  ['boogu-image-turbo', 'mllm/vocab.json'],
  ['boogu-image-turbo', 'mllm/tokenizer_config.json'],
  ['ming-image-design', 'mllm/tokenizer.json'],
  ['ming-image-design', 'connector/0.safetensors'],
  ['ming-image-design', 'mlp/0.safetensors'],
])('rejects incomplete %s bundles missing %s', async (id, path) => {
  await rm(join(directory, path));
  await expect(prepareModel(id, { directory })).rejects.toMatchObject({ code: 'MODEL_IO' });
});
