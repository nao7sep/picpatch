import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { listModels, prepareModel, validateGenerateRequest, validateEditRequest } from '../../src/index.ts';
import { hiDreamConditioning } from '../../src/backends/stable-diffusion-cpp/hidream.ts';
import { nativeWeightArguments } from '../../src/backends/stable-diffusion-cpp/flow.ts';
import { tensorFile, hiDreamShapes as shapes } from '../helpers/native-assets.ts';
let directory: string;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'picpatch-hidream-')); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
it.each(['hidream-o1', 'hidream-o1-dev'])('prepares %s as one fingerprinted combined checkpoint', async variant => {
  await tensorFile(join(directory, 'model.safetensors'), shapes);
  const options = { directory, checkpoint: 'model.safetensors' };
  const { model } = await prepareModel(variant, options);
  expect(model.manifest.components).toHaveLength(1);
  expect(nativeWeightArguments(model)).toEqual(['--model', join(directory, options.checkpoint)]);
  expect(listModels().find(entry => entry.id === variant)).toMatchObject({ acquisition: 'external', evidence: 'source', family: 'hidream-o1' });
  for (const extra of [{ vae: 'vae.gguf' }, { t5: 't5.gguf' }, { loras: [{ path: 'lora.safetensors' }] }]) {
    await expect(prepareModel(variant, { ...options, ...extra })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  }
  for (const key of Object.keys(shapes)) {
    await tensorFile(join(directory, options.checkpoint), Object.fromEntries(Object.entries(shapes).filter(([name]) => name !== key)));
    await expect(prepareModel(variant, options)).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await tensorFile(join(directory, options.checkpoint), { ...shapes, [key]: [1] });
    await expect(prepareModel(variant, options)).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  }
});
it.each(['hidream-o1', 'hidream-o1-dev'])('advertises only the native %s generation and ordered-image contract', variant => {
  const caps = listModels().find(entry => entry.id === variant)!.capabilities;
  expect(() => validateGenerateRequest({ model: variant, prompt: 'A bowl', outputPath: '/out.png' }, caps)).not.toThrow();
  const request = { model: variant, instruction: 'Make the bowl blue', outputPath: '/out.png', sourceImage: '/source.png' };
  expect(() => validateEditRequest(request, caps)).not.toThrow();
  for (const extra of [{ maskImage: '/mask.png' }, { parameters: { strength: 0.5 } }, { size: { width: 1000, height: 1000 } }, { references: [{ id: 'person', role: 'subject', conditioning: 'identity', images: ['/ref.png'] }] }]) expect(() => validateEditRequest({ ...request, ...extra }, caps)).toThrow();
  if (variant.endsWith('-dev')) for (const parameters of [{ guidance: 5 }, { negativePrompt: 'blur' }]) expect(() => validateEditRequest({ ...request, parameters }, caps)).toThrow();
});
it('keeps all source and group ordinals aligned, without pretending to bind identities', () => {
  const request = validateEditRequest({ model: 'hidream-o1', instruction: 'Arrange the subjects', outputPath: '/out.png', sourceImage: '/source.png', references: [
    { id: 'first', role: 'subject', images: ['/a.png', '/b.png'] }, { id: 'other', role: 'object', images: ['/c.png'] },
  ] });
  const compiled = hiDreamConditioning(request);
  expect(compiled.paths).toEqual(['/source.png', '/a.png', '/b.png', '/c.png']);
  expect(compiled.prompt).toBe('Image 1 is the source image to edit.\nImages 2, 3 are subject references for group "first".\nImages 4 are object references for group "other".\n\nArrange the subjects');
});
