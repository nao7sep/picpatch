import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createEditor, listModels, prepareModel } from 'picpatch';
import { nativeCheckpoint, tensorFile } from '../helpers/native-assets.ts';
let directory: string;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'picpatch-lora-')); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
const target = 'lora_unet_down_blocks_0_attentions_0_transformer_blocks_0_attn2_to_k';
it.each(['sd15', 'sdxl', 'sd15-inpaint', 'sdxl-inpaint'])('prepares %s LoRA pairs against actual checkpoint targets without changing files', async variant => {
  await nativeCheckpoint(join(directory, 'base.safetensors'), variant);
  await tensorFile(join(directory, 'style.safetensors'), { [`${target}.lora_down.weight`]: [4, variant.startsWith('sdxl') ? 2048 : 768], [`${target}.lora_up.weight`]: [320, 4], [`${target}.alpha`]: [] });
  const original = await readFile(join(directory, 'style.safetensors'));
  const result = await prepareModel(variant, { directory, checkpoint: 'base.safetensors', loras: [{ path: 'style.safetensors', scale: -0.5 }] });
  expect(result.model.loras).toEqual([{ path: 'style.safetensors', scale: -0.5 }]);
  expect(result.model.manifest.components).toHaveLength(2);
  expect(await readFile(join(directory, 'style.safetensors'))).toEqual(original);
  expect(listModels().find(model => model.id === variant)!.capabilities.loraFormats).toEqual(['sd-unet-safetensors']);
});
it.each(['wrong-width', 'missing-up', 'unknown-target', 'text-encoder', 'rank-mismatch'])('rejects %s before fingerprinting weights', async failure => {
  await nativeCheckpoint(join(directory, 'base.safetensors'), 'sd15');
  const name = failure === 'text-encoder' ? 'lora_te_encoder' : failure === 'unknown-target' ? 'lora_unet_unknown' : target;
  await tensorFile(join(directory, 'style.safetensors'), { [`${name}.lora_down.weight`]: [4, failure === 'wrong-width' ? 2048 : 768],
    ...(failure === 'missing-up' ? {} : { [`${name}.lora_up.weight`]: [320, failure === 'rank-mismatch' ? 8 : 4] }) });
  const onProgress = vi.fn();
  await expect(prepareModel('sd15', { directory, checkpoint: 'base.safetensors', loras: [{ path: 'style.safetensors' }], onProgress })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  expect(onProgress).not.toHaveBeenCalled();
});
it.each([null, [], [{ path: '../outside.safetensors' }], [{ path: 'a.safetensors', scale: Infinity }], [{ path: 'a.gguf' }], [{ path: 'a.safetensors' }, { path: 'a.safetensors' }]])('rejects malformed selections without model IO', async loras => {
  await expect(prepareModel('sd15', { directory, checkpoint: 'base.safetensors', loras: loras as never })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
});
it('rejects LoRA registrations on unsupported runtimes', () => {
  expect(() => createEditor({ model: { variant: 'flux2-klein-4b', directory, loras: [{ path: 'style.safetensors' }], manifest: { version: 1, model: 'fixture', source: { repository: 'local', revision: 'a'.repeat(64) }, components: [{ path: 'style.safetensors', role: 'weights', bytes: 1, sha256: 'a'.repeat(64) }] } } })).toThrow(expect.objectContaining({ code: 'INVALID_REQUEST' }));
});
it.each([
  ['input_blocks.4.0.in_layers.2', 'down_blocks_1_resnets_0_conv1'],
  ['input_blocks.3.0.op', 'down_blocks_0_downsamplers_0_conv'],
  ['output_blocks.5.0.skip_connection', 'up_blocks_1_resnets_2_conv_shortcut'],
  ['output_blocks.2.2.conv', 'up_blocks_0_upsamplers_0_conv'],
  ['middle_block.2.out_layers.3', 'mid_block_resnets_1_conv2'],
])('checks convolution targets for %s', async (original, alias) => {
  await tensorFile(join(directory, 'base.safetensors'), {
    'model.diffusion_model.input_blocks.0.0.weight': [320, 4, 3, 3],
    'model.diffusion_model.input_blocks.1.1.transformer_blocks.0.attn2.to_k.weight': [320, 768],
    [`model.diffusion_model.${original}.weight`]: [640, 320, 3, 3],
  });
  await tensorFile(join(directory, 'style.safetensors'), { [`lora_unet_${alias}.lora_down.weight`]: [2, 320, 3, 3], [`lora_unet_${alias}.lora_up.weight`]: [640, 2, 1, 1] });
  await expect(prepareModel('sd15', { directory, checkpoint: 'base.safetensors', loras: [{ path: 'style.safetensors' }] })).resolves.toMatchObject({ origin: 'external' });
});
