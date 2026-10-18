import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { listModels, prepareModel, validateEditRequest, validateGenerateRequest } from '../../src/index.ts';
import { nativeAssets, tensorFile } from '../helpers/native-assets.ts';

let directory: string;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'picpatch-conditioning-')); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
const variants = ['sdxl-photomaker-v1', 'sd15-ip-adapter', 'sdxl-ip-adapter', 'sd15-ip-adapter-plus', 'sdxl-ip-adapter-plus'];
it.each(variants)('prepares exactly the compatible assets for %s and rejects missing or wrong components', async variant => {
  const options = await nativeAssets(directory, variant);
  const prepared = await prepareModel(variant, options);
  expect(prepared.model.manifest.components).toHaveLength(variant.includes('photomaker') ? 2 : 3);
  expect(prepared.integrity).toBe('locally-fingerprinted');
  await expect(prepareModel(variant, { directory, checkpoint: options.checkpoint })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  await tensorFile(join(directory, options.checkpoint), { 'model.diffusion_model.input_blocks.0.0.weight': [320, 9, 3, 3] });
  await expect(prepareModel(variant, options)).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
});
it('rejects V2, wrong vision dimensions, cross-family adapters, and malformed headers', async () => {
  const pm = await nativeAssets(directory, 'sdxl-photomaker-v1');
  await tensorFile(join(directory, pm.photoMaker!), { 'qformer_perceiver.weight': [1] });
  await expect(prepareModel('sdxl-photomaker-v1', pm)).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  const ip = await nativeAssets(directory, 'sd15-ip-adapter');
  await tensorFile(join(directory, ip.clipVision!), { 'vision_model.embeddings.patch_embedding.weight': [1664, 3, 14, 14] });
  await expect(prepareModel('sd15-ip-adapter', ip)).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  await nativeAssets(directory, 'sd15-ip-adapter');
  await tensorFile(join(directory, ip.ipAdapter!), { 'image_proj.norm.weight': [2048], 'image_proj.proj.weight': [8192, 1024] });
  await expect(prepareModel('sd15-ip-adapter', ip)).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  await writeFile(join(directory, ip.ipAdapter!), Buffer.alloc(8, 255));
  await expect(prepareModel('sd15-ip-adapter', ip)).rejects.toMatchObject({ code: 'MODEL_IO' });
});
it('detects mutation of an earlier hashed file by a later preparation callback', async () => {
  const options = await nativeAssets(directory, 'sd15-ip-adapter');
  // Synchronous filesystem mutation inside the progress callback is deliberate adversarial input.
  const { writeFileSync } = await import('node:fs');
  let changed = false;
  await expect(prepareModel('sd15-ip-adapter', { ...options, onProgress: event => {
    if (event.completed === event.total && !changed) { changed = true; writeFileSync(join(directory, options.checkpoint), 'changed'); }
  } })).rejects.toMatchObject({ code: 'MODEL_IO' });
  expect(changed).toBe(true);
});
it('cancels before loading or changing caller assets', async () => {
  const options = await nativeAssets(directory, 'sdxl-photomaker-v1');
  const before = await readFile(join(directory, options.photoMaker!));
  await expect(prepareModel('sdxl-photomaker-v1', { ...options, signal: AbortSignal.abort() })).rejects.toMatchObject({ code: 'CANCELLED' });
  expect(await readFile(join(directory, options.photoMaker!))).toEqual(before);
});
it('keeps one pooled identity distinct from appearance and prompt groups', () => {
  const model = 'sdxl-photomaker-v1'; const caps = listModels().find(item => item.id === model)!.capabilities;
  const request = { model, instruction: 'A portrait of {person}.', outputPath: '/out.png', references: [{ id: 'person', role: 'subject', conditioning: 'identity', className: 'man', images: ['/a.png', '/b.png'] }] };
  expect(() => validateEditRequest(request, caps)).not.toThrow();
  for (const extra of [{ sourceImage: '/source.png' }, { instruction: 'A portrait without a placeholder.' }, { instruction: '{person} and {person}' }, { instruction: '{person} img' }, { references: [...request.references, { ...request.references[0], id: 'other', images: ['/c.png'] }] }, { parameters: { identityStyleStrength: 101 } }]) {
    expect(() => validateEditRequest({ ...request, ...extra }, caps)).toThrow();
  }
  expect(() => validateEditRequest({ ...request, instruction: 'A portrait of {img}.', references: [{ ...request.references[0], id: 'img' }] }, caps)).not.toThrow();
  const klein = listModels().find(item => item.id === 'flux2-klein-4b')!.capabilities;
  expect(() => validateEditRequest({ ...request, model: klein.model }, klein)).toThrow();
  const appearance = listModels().find(item => item.id === 'sd15-ip-adapter')!.capabilities;
  const input = { model: appearance.model, instruction: 'Blue style', outputPath: '/out.png', references: [{ id: 'style', role: 'style', conditioning: 'appearance', images: ['/a.png'] }] };
  expect(() => validateEditRequest(input, appearance)).not.toThrow();
  expect(() => validateEditRequest({ ...input, references: [{ ...input.references[0], images: ['/a.png', '/b.png'] }] }, appearance)).toThrow();
  expect(() => validateGenerateRequest({ model, prompt: 'Portrait', outputPath: '/out.png' }, caps)).toThrow();
});
