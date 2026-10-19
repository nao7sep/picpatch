import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { listModels, prepareModel, validateGenerateRequest, validateEditRequest, type PrepareModelOptions } from '../../src/index.ts';
import { nativeWeightArguments } from '../../src/backends/stable-diffusion-cpp/flow.ts';
import { tensorFile } from '../helpers/native-assets.ts';
let directory: string;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'picpatch-native-flow-')); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
async function fixture(variant: string): Promise<PrepareModelOptions & { checkpoint: string }> {
  await tensorFile(join(directory, 'model.safetensors'), variant === 'sd35-large' ? {
    'model.diffusion_model.joint_blocks.37.x_block.attn.qkv.weight': [1], 'model.diffusion_model.x_embedder.proj.weight': [1], 'first_stage_model.decoder.conv_out.weight': [1],
  } : { 'double_blocks.0.img_attn.qkv.weight': [1], [variant === 'chroma' ? 'distilled_guidance_layer.in_proj.weight' : 'nerf_final_layer_conv.weight']: [1] });
  for (const name of ['t5', 'clip-l', 'clip-g', 'vae']) await writeFile(join(directory, `${name}.gguf`), 'synthetic component, not inference weights');
  return { directory, checkpoint: 'model.safetensors', t5: 't5.gguf', ...(variant === 'sd35-large' ? { clipL: 'clip-l.gguf', clipG: 'clip-g.gguf' } : variant === 'chroma' ? { vae: 'vae.gguf' } : {}) };
}
it.each(['sd35-large', 'chroma', 'chroma-radiance'])('prepares complete %s assets and maps every selected file to its native CLI argument', async variant => {
  const options = await fixture(variant);
  const { model } = await prepareModel(variant, options);
  expect(model.manifest.components).toHaveLength(variant === 'sd35-large' ? 4 : variant === 'chroma' ? 3 : 2);
  const args = nativeWeightArguments(model);
  for (const file of model.manifest.components) expect(args).toContain(join(directory, file.path));
  expect(args[0]).toBe(variant === 'sd35-large' ? '--model' : '--diffusion-model');
  expect(args).toContain('--t5xxl');
  if (variant === 'sd35-large') expect(args).toEqual(expect.arrayContaining(['--clip_l', '--clip_g']));
  if (variant === 'chroma-radiance') expect(args).not.toContain('--vae');
  const entry = listModels().find(item => item.id === variant)!;
  expect(entry).toMatchObject({ evidence: 'source', acquisition: 'external' });
  expect(() => validateGenerateRequest({ model: variant, prompt: 'A ceramic cup', outputPath: '/out.png' }, entry.capabilities)).not.toThrow();
  expect(() => validateEditRequest({ model: variant, instruction: 'Blue', sourceImage: '/in.png', outputPath: '/out.png' }, entry.capabilities)).toThrow();
  expect(() => validateGenerateRequest({ model: variant, prompt: 'Blue', outputPath: '/out.png', parameters: { strength: 0.5 } }, entry.capabilities)).toThrow();
  const { t5: _t5, ...missingT5 } = options;
  await expect(prepareModel(variant, missingT5)).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  for (const extra of [ { t5: options.checkpoint }, { loras: [{ path: 'adapter.safetensors' }] }]) await expect(prepareModel(variant, { ...options, ...extra })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  await tensorFile(join(directory, options.checkpoint), { 'model.diffusion_model.input_blocks.0.0.weight': [320, 4, 3, 3] });
  await expect(prepareModel(variant, options)).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
});
it('rejects cross-family components and a missing embedded VAE before loading', async () => {
  const sd3 = await fixture('sd35-large');
  const { clipG: _clipG, ...missingClipG } = sd3;
  await expect(prepareModel('sd35-large', missingClipG)).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  await tensorFile(join(directory, sd3.checkpoint), { 'joint_blocks.37.x_block.attn.qkv.weight': [1], 'x_embedder.proj.weight': [1] });
  await expect(prepareModel('sd35-large', sd3)).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  await expect(prepareModel('sd35-large', { ...sd3, vae: 'vae.gguf' })).resolves.toMatchObject({ origin: 'external' });
  const radiance = await fixture('chroma-radiance');
  await expect(prepareModel('chroma-radiance', { ...radiance, vae: 'vae.gguf' })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  await expect(prepareModel('chroma-radiance', { ...radiance, clipL: 'clip-l.gguf' })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
});
