import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { expect, it } from 'vitest';
import { createImageClient, prepareModel } from 'picpatchsdk';
import { nativeRevision } from '../../src/backends/stable-diffusion-cpp/models.ts';
import { controlNetShapes, nativeCheckpoint, tensorFile } from '../helpers/native-assets.ts';

it.each(['sd15', 'sdxl'].flatMap(variant => (['canny', 'depth', 'pose'] as const).map(kind => ({ variant, kind }))))('keeps LoRA filenames literal and maps prepared $variant/$kind conditioning through private CLI inputs', async ({ variant, kind }) => {
  const directory = await mkdtemp(join(tmpdir(), 'picpatch-control-cli-'));
  try {
    const executable = join(directory, 'sd-cli');
    const image = join(directory, 'map.png');
    const png = await sharp({ create: { width: 16, height: 16, channels: 3, background: 'blue' } }).png().toBuffer();
    await writeFile(image, png);
    await nativeCheckpoint(join(directory, 'base.safetensors'), variant);
    await tensorFile(join(directory, 'canny.safetensors'), controlNetShapes(variant === 'sdxl' ? 2048 : 768));
    const target = 'lora_unet_down_blocks_0_attentions_0_transformer_blocks_0_attn2_to_k';
    for (const filename of ['one odd name.safetensors', 'two.safetensors']) await tensorFile(join(directory, filename), { [`${target}.lora_down.weight`]: [1, variant === 'sdxl' ? 2048 : 768], [`${target}.lora_up.weight`]: [320, 1] });
    await writeFile(executable, `#!${process.execPath}
const fs = require('node:fs'); const path = require('node:path'); const args = process.argv.slice(2);
if (args.includes('--help')) { console.log('stable-diffusion.cpp version fixture, commit ${nativeRevision}'); process.exit(0); }
const value = name => args[args.indexOf(name) + 1];
const prompt = fs.readFileSync(value('--prompt-file'), 'utf8');
if (prompt !== 'A bowl. <lora:adapter-0:1> <lora:adapter-1:-0.5>') process.exit(10);
if (value('--lora-apply-mode') !== 'at_runtime') process.exit(11);
for (let i = 0; i < 2; i++) if (!fs.existsSync(path.join(value('--lora-model-dir'), 'adapter-' + i + '.safetensors'))) process.exit(12);
if (args.includes('--control-net')) {
 if (value('--sampling-method') !== 'dpm++2m' || value('--scheduler') !== 'karras') process.exit(14);
 if (value('--control-strength') !== '0.9' || path.dirname(value('--control-image')) !== process.cwd()) process.exit(13);
}
fs.writeFileSync(value('--output'), Buffer.from('${png.toString('base64')}', 'base64'));
`, { mode: 0o700 });
    const model = (await prepareModel(variant, { directory, checkpoint: 'base.safetensors', controlNet: { kind, path: 'canny.safetensors' }, loras: [{ path: 'one odd name.safetensors' }, { path: 'two.safetensors', scale: -0.5 }] })).model;
    const editor = createImageClient({ model, nativeExecutable: executable, defaults: { size: { width: 16, height: 16 }, outputDirectory: directory } });
    try {
      const ordinary = await editor.generate({ prompt: 'A bowl.' });
      if ('status' in ordinary) throw new Error(ordinary.code);
      expect(ordinary.control).toBeUndefined();
      const controlled = await editor.generate({ prompt: 'A bowl.', control: { kind, image }, parameters: { sampler: 'dpm++2m', scheduler: 'karras' }, sidecar: {} });
      if ('status' in controlled) throw new Error(controlled.code);
      expect(controlled.control).toMatchObject({ kind, strength: 0.9 });
      expect(controlled.record.effectiveParameters).toMatchObject({ sampler: 'dpm++2m', scheduler: 'karras' });
      expect(controlled.loras?.map(lora => lora.filename)).toEqual(['one odd name.safetensors', 'two.safetensors']);
      expect(await readFile(controlled.sidecar!.path, 'utf8')).not.toContain(directory);
    } finally { await editor.dispose(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
