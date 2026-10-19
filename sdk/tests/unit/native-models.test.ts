import { nativeCheckpoint, tensorFile } from '../helpers/native-assets.ts';
import { mkdtemp, writeFile, readdir, rm, symlink, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createImageClient, listModels, prepareModel, verifyModel, validateGenerateRequest, validateEditRequest, type EditInput } from '../../src/index.ts';

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'picpatch-native-model-'));
  await nativeCheckpoint(join(directory, 'custom.safetensors'), 'sdxl');
  await writeFile(join(directory, 'vae.gguf'), 'synthetic vae');
});
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

it('uses a shared profile for native preparation without redirecting or creating model storage', async () => {
  const options = { directory, checkpoint: 'custom.safetensors' };
  const expected = await prepareModel('sdxl', options);
  const profile = { version: 1 as const, modelsDirectory: join(directory, 'profile-models'), engineDirectory: join(directory, 'engine') };
  expect(await prepareModel('sdxl', { ...options, profile })).toEqual(expected);
  expect(await prepareModel('sdxl', { ...options, profile, modelsDirectory: join(directory, 'explicit-models') })).toEqual(expected);
  await expect(prepareModel('sdxl', { ...options, modelsDirectory: 'relative' })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  expect((await readdir(directory)).sort()).toEqual(['custom.safetensors', 'vae.gguf']);
});

it.each(['sd15', 'sdxl', 'sd15-inpaint', 'sdxl-inpaint'])('prepares explicit %s files without copying, installing or claiming inference evidence', async id => {
  await nativeCheckpoint(join(directory, 'custom.safetensors'), id);
  const before = await readdir(directory);
  const options = { directory, checkpoint: 'custom.safetensors', vae: 'vae.gguf' };
  const prepared = await prepareModel(id, options);
  expect(prepared.model).toMatchObject({ variant: id, checkpoint: options.checkpoint, vae: options.vae });
  expect(prepared.integrity).toBe('locally-fingerprinted');
  expect((await verifyModel(directory, prepared.model.manifest)).status).toBe('matches-manifest');
  expect((await prepareModel(id, options)).model.manifest).toEqual(prepared.model.manifest);
  expect(await readdir(directory)).toEqual(before);
  expect(listModels().find(item => item.id === id)).toMatchObject({ evidence: id === 'sdxl-inpaint' ? 'source' : 'real-weights', acquisition: 'external' });
  await writeFile(join(directory, 'vae.gguf'), 'replacement');
  expect((await prepareModel(id, options)).model.manifest.source.revision).not.toBe(prepared.model.manifest.source.revision);
});

it('rejects implicit acquisition, ambiguous files and bad registration before execution', async () => {
  for (const extra of [{}, { checkpoint: '../custom.safetensors' }, { checkpoint: 'custom.ckpt' }, { checkpoint: 'custom.safetensors', vae: 'custom.safetensors' }, { checkpoint: 'custom.safetensors', download: true }]) {
    await expect(prepareModel('sdxl', { directory, ...extra })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  }
  const { model } = await prepareModel('sdxl', { directory, checkpoint: 'custom.safetensors' });
  expect(() => createImageClient({ model })).toThrow(expect.objectContaining({ code: 'INVALID_REQUEST' }));
  expect(() => createImageClient({ model: { ...model, quantize: 4 }, nativeExecutable: '/sd-cli' })).toThrow(expect.objectContaining({ code: 'INVALID_REQUEST' }));
  expect(() => createImageClient({ model: { ...model, checkpoint: 'undeclared.safetensors' }, nativeExecutable: '/sd-cli' })).toThrow();
  const editor = createImageClient({ model, nativeExecutable: '/missing/sd-cli' });
  await editor.dispose();
});

it('cancels preparation and rejects directory indirection without mutating external files', async () => {
  const controller = new AbortController();
  await expect(prepareModel('sdxl', { directory, checkpoint: 'custom.safetensors', signal: controller.signal, onEvent: () => controller.abort() })).rejects.toMatchObject({ code: 'CANCELLED' });
  await mkdir(join(directory, 'actual'));
  await writeFile(join(directory, 'actual/weights.gguf'), 'test');
  await symlink(join(directory, 'actual'), join(directory, 'linked'));
  await expect(prepareModel('sdxl', { directory, checkpoint: 'linked/weights.gguf' })).rejects.toMatchObject({ code: 'MODEL_IO' });
});

it('distinguishes base variation from dedicated inpaint before image I/O', () => {
  const base = listModels().find(m => m.id === 'sdxl')!.capabilities;
  const mask = listModels().find(m => m.id === 'sdxl-inpaint')!.capabilities;
  expect(() => validateGenerateRequest({ model: base.model, prompt: 'Blue', outputPath: '/out.png' }, base)).not.toThrow();
  expect(() => validateEditRequest({ model: base.model, instruction: 'Blue', sourceImage: '/in.png', outputPath: '/out.png' }, base)).not.toThrow();
  expect(() => validateEditRequest({ model: mask.model, instruction: 'Blue', sourceImage: '/in.png', outputPath: '/out.png' }, mask)).toThrow();
  expect(() => validateEditRequest({ model: mask.model, instruction: 'Blue', sourceImage: '/in.png', maskImage: '/mask.png', outputPath: '/out.png', parameters: { strength: 0.5 } }, mask)).toThrow();
});

it.each(['sd15', 'sdxl'])('admits %s source variation and rejects incompatible inputs before starting the executable', async id => {
  await nativeCheckpoint(join(directory, 'custom.safetensors'), id);
  const { model } = await prepareModel(id, { directory, checkpoint: 'custom.safetensors' });
  const editor = createImageClient({ model, nativeExecutable: '/missing/sd-cli', defaults: { outputDirectory: directory } });
  const request = { instruction: 'Blue', sourceImage: '/missing/image.png' };
  try {
    for (const extra of [{ maskImage: '/missing/mask.png' }, { references: [{ id: 'style', role: 'style' as const, images: ['/missing/ref.png'] }] }, { size: { width: 17, height: 16 } }] satisfies Partial<EditInput>[]) {
      await expect(editor.edit({ ...request, ...extra })).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
    }
    for (const strength of [-0.1, 1.1, NaN, Infinity]) {
      await expect(editor.edit({ ...request, parameters: { strength } })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    }
    await expect(editor.edit({ instruction: 'Blue', references: [{ id: 'style', role: 'style', images: ['/missing/ref.png'] }] })).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
    await expect(editor.generate({ prompt: 'Blue', parameters: { strength: 0.5 } })).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
  } finally { await editor.dispose(); }
});

it.each(['sd15', 'sdxl', 'sd15-inpaint', 'sdxl-inpaint'])('rejects mismatched architecture and base/inpaint headers for %s before hashing', async variant => {
  for (const actual of ['sd15', 'sdxl', 'sd15-inpaint', 'sdxl-inpaint'].filter(id => id !== variant)) {
    await nativeCheckpoint(join(directory, 'custom.safetensors'), actual);
    let hashing = false;
    await expect(prepareModel(variant, { directory, checkpoint: 'custom.safetensors', onProgress: () => { hashing = true; } })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(hashing).toBe(false);
  }
});

it('rejects incomplete component exports and malformed native safetensors headers', async () => {
  await tensorFile(join(directory, 'custom.safetensors'), { 'conv_in.weight': [320, 4, 3, 3] });
  await expect(prepareModel('sdxl', { directory, checkpoint: 'custom.safetensors' })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  for (const bytes of [Buffer.from('short'), Buffer.alloc(8, 255), Buffer.from('12345678{}')]) {
    await writeFile(join(directory, 'custom.safetensors'), bytes);
    await expect(prepareModel('sdxl', { directory, checkpoint: 'custom.safetensors' })).rejects.toMatchObject({ code: 'MODEL_IO' });
  }
});
