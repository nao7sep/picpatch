import { mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { expect, it } from 'vitest';
import { createImageClient, prepareModel } from 'picpatchsdk';
import { loraWeights } from '../helpers/lora-weights.ts';
import { liveCache } from '../helpers/live-cache.ts';
it.each(['sd15', 'sdxl'])('applies a local LoRA at distinct scales during real native inference with path-free provenance', async variant => {
  const config = JSON.parse(await readFile(process.env.PICPATCH_NATIVE_INFERENCE_CONFIG ?? liveCache('native-inference-config.json'), 'utf8'));
  const directory = await mkdtemp(join(tmpdir(), 'picpatch-lora-inference-'));
  try {
    await symlink(join(config.directory, variant === 'sdxl' ? config.checkpoint : config.sd15Checkpoint), join(directory, 'base.safetensors'));
    await loraWeights(join(directory, 'adapter.safetensors'), variant === 'sdxl');
    const prepared = await prepareModel(variant, { directory, checkpoint: 'base.safetensors', loras: [{ path: 'adapter.safetensors' }] });
    const original = await readFile(join(directory, 'adapter.safetensors'));
    const pixels: Buffer[] = [];
    for (const scale of [0, 1, -1]) {
      const editor = createImageClient({ nativeExecutable: config.executable, model: { ...prepared.model, loras: [{ path: 'adapter.safetensors', scale }] }, defaults: { outputDirectory: directory, size: { width: 256, height: 256 }, seed: 42 } });
      try {
        const result = await editor.generate({ prompt: 'A blue ceramic bowl on a table.', parameters: { steps: 4 }, sidecar: true });
        if (result.status === 'refused') throw new Error(result.code);
        expect(result.loras).toEqual([{ filename: 'adapter.safetensors', scale, sha256: prepared.model.manifest.components[1]!.sha256 }]);
        const text = await readFile(result.sidecar!.path, 'utf8'); expect(text).not.toContain(directory);
        expect(JSON.parse(text).loras).toEqual(result.loras);
        expect((await sharp(result.image.path).stats()).channels.some(channel => channel.stdev > 1)).toBe(true);
        pixels.push(await sharp(result.image.path).raw().toBuffer());
      } finally { await editor.dispose(); }
    }
    expect(pixels[0]!.equals(pixels[1]!)).toBe(false);
    expect(pixels[1]!.equals(pixels[2]!)).toBe(false);
    expect(await readFile(join(directory, 'adapter.safetensors'))).toEqual(original);
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 600_000);
