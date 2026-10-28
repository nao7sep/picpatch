import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { expect, it } from 'vitest';
import { createImageClient, prepareModel } from 'picpatchsdk';
import assets from '../fixtures/native-sd15-assets.json' with { type: 'json' };
import { nativeInferenceConfigPath } from '../helpers/live-cache.ts';

it('runs SD1.5 generation, variation and trained inpainting with thresholded masks and resized canvases', async () => {
  const path = nativeInferenceConfigPath();
  const config = JSON.parse(await readFile(path, 'utf8')) as { directory: string; executable: string; sd15Checkpoint: string; sd15InpaintCheckpoint: string };
  if (!config.sd15Checkpoint || !config.sd15InpaintCheckpoint) throw new Error('Prepare the documented SD1.5 base/inpaint test assets. This test never downloads weights.');
  const directory = await mkdtemp(join(tmpdir(), 'picpatch-native-inpaint-'));
  const options = { nativeExecutable: config.executable, defaults: { outputDirectory: directory, size: { width: 256, height: 256 }, seed: 42 } };
  let phase = 'base preparation';
  try {
    const base = await prepareModel('sd15', { directory: config.directory, checkpoint: config.sd15Checkpoint });
    expect(base.model.manifest.components[0]!.sha256).toBe(assets[0]!.sha256);
    const editor = createImageClient({ ...options, model: base.model });
    const sourceImage = join(directory, 'source.png');
    try {
      phase = 'base generation';
      const image = await editor.generate({ prompt: 'A blue ceramic bowl on a wooden table.', parameters: { steps: 4 } });
      if (image.status === 'refused') throw new Error(image.code);
      expect((await sharp(image.image.path).stats()).channels.some(channel => channel.stdev > 1)).toBe(true);
      await sharp(image.image.path).resize(320, 192).png().toFile(sourceImage);
      phase = 'source variation';
      const variation = await editor.edit({ instruction: 'A green ceramic bowl on a wooden table.', sourceImage, parameters: { steps: 4, strength: 0.5 } });
      if (variation.status === 'refused') throw new Error(variation.code);
      expect(variation.effectiveParameters.strength).toBe(0.5);
      expect(await sharp(variation.image.path).metadata()).toMatchObject({ width: 256, height: 256 });
    } finally { await editor.dispose(); }
    phase = 'inpaint preparation';
    const prepared = await prepareModel('sd15-inpaint', { directory: config.directory, checkpoint: config.sd15InpaintCheckpoint });
    expect(prepared.model.manifest.components[0]!.sha256).toBe(assets[1]!.sha256);
    const inpaint = createImageClient({ ...options, model: prepared.model });
    const original = await readFile(sourceImage);
    const pixels = new Map<number, Buffer>();
    try {
      // Constant masks isolate the runtime's documented 127/128 threshold from resize interpolation.
      for (const value of [0, 127, 128, 255]) {
        phase = `mask ${value}`;
        const maskImage = join(directory, `mask-${value}.png`);
        await sharp(Buffer.alloc(320 * 192, value), { raw: { width: 320, height: 192, channels: 1 } }).toColourspace('b-w').png().toFile(maskImage);
        const maskBytes = await readFile(maskImage);
        const result = await inpaint.edit({ instruction: 'A red glass vase on a wooden table.', sourceImage, maskImage, parameters: { steps: 4 }, sidecar: true });
        if (result.status === 'refused') throw new Error(result.code);
        expect(result.effectiveParameters.strength).toBe(1);
        expect(await sharp(result.image.path).metadata()).toMatchObject({ width: 256, height: 256 });
        expect((await sharp(result.image.path).stats()).channels.some(channel => channel.stdev > 1)).toBe(true);
        pixels.set(value, await sharp(result.image.path).removeAlpha().raw().toBuffer());
        expect(await readFile(maskImage)).toEqual(maskBytes);
        const sidecar = await readFile(result.sidecar!.path, 'utf8');
        expect(sidecar).not.toContain(directory); expect(sidecar).not.toContain(config.directory);
        expect((await sharp(result.image.path).metadata()).comments ?? []).toEqual([]);
      }
      const distance = (a: Buffer, b: Buffer) => {
        let total = 0;
        for (let i = 0; i < a.length; i++) total += Math.abs(a[i]! - b[i]!);
        return total / a.length;
      };
      const repeated = await inpaint.edit({ instruction: 'A red glass vase on a wooden table.', sourceImage, maskImage: join(directory, 'mask-0.png'), parameters: { steps: 4 } });
      if (repeated.status === 'refused') throw new Error(repeated.code);
      // Permit at most one intensity level of average numerical variation between
      // independent native runs; a threshold reversal changes the whole canvas.
      expect(distance(pixels.get(0)!, await sharp(repeated.image.path).removeAlpha().raw().toBuffer())).toBeLessThanOrEqual(1);
      expect(distance(pixels.get(0)!, pixels.get(127)!)).toBeLessThanOrEqual(1);
      expect(distance(pixels.get(128)!, pixels.get(255)!)).toBeLessThanOrEqual(1);
      expect(distance(pixels.get(0)!, pixels.get(255)!)).toBeGreaterThan(1);
      phase = 'partial mask';
      const maskImage = join(directory, 'partial.png');
      const mask = Buffer.alloc(320 * 192);
      for (let y = 48; y < 144; y++) mask.fill(255, y * 320 + 80, y * 320 + 240);
      await sharp(mask, { raw: { width: 320, height: 192, channels: 1 } }).toColourspace('b-w').png().toFile(maskImage);
      await inpaint.edit({ instruction: 'A red glass vase.', sourceImage, maskImage, parameters: { steps: 4 } });
      phase = 'outpainting';
      const extended = await inpaint.edit({ instruction: 'A wooden table extending around the bowl.', sourceImage, outpaint: { size: { width: 384, height: 256 }, left: 32, top: 32 }, size: { width: 384, height: 256 }, parameters: { steps: 4 } });
      if (extended.status === 'refused') throw new Error(extended.code);
      expect(await sharp(extended.image.path).metadata()).toMatchObject({ width: 384, height: 256 });
      expect((await sharp(extended.image.path).stats()).channels.some(channel => channel.stdev > 1)).toBe(true);
      phase = 'inpaint cancellation';
      const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await expect(inpaint.edit({ instruction: 'A red vase.', sourceImage, maskImage, parameters: { steps: 10000 } }, { signal: controller.signal, onEvent: event => {
          if (event.stage === 'editing') timer = setTimeout(() => controller.abort(), 1500);
        } })).rejects.toMatchObject({ code: 'CANCELLED' });
      } finally { clearTimeout(timer); }
      expect(await readFile(sourceImage)).toEqual(original);
    } finally { await inpaint.dispose(); }
    expect((await readdir(directory)).some(name => name.startsWith('.picpatch-'))).toBe(false);
  } catch (cause) { throw new Error(`Native SD1.5 inference failed during ${phase}.`, { cause }); }
  finally { await rm(directory, { recursive: true, force: true }); }
});
