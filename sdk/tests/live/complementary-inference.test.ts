import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { expect, it } from 'vitest';
import { createImageClient, prepareModel } from 'picpatchsdk';
import { testEngineDirectory } from '../helpers/engine.ts';
import { liveCache } from '../helpers/live-cache.ts';

it('generates with Z-Image Turbo then performs native masked editing with FLUX Fill', async () => {
  const models = process.env.PICPATCH_COMPLEMENTARY_MODELS ?? liveCache('complementary-models/');
  const directory = await mkdtemp(join(tmpdir(), 'picpatch-complementary-'));
  try {
    const generation = await prepareModel('z-image-turbo-4bit', { directory: join(models, 'z-image-turbo-q4') });
    const fill = await prepareModel('flux1-fill-dev-4bit', { directory: join(models, 'flux1-fill-q4') });
    expect(generation.integrity).toBe('matches-manifest');
    expect(fill.integrity).toBe('matches-manifest');
    const sourceImage = join(directory, 'source.png');
    const maskImage = join(directory, 'mask.png');
    const generated = createImageClient({ engineDirectory: testEngineDirectory, model: generation.model });
    try {
      const result = await generated.generate({ prompt: 'A small blue ceramic vase on a pale wooden table, product photography.', seed: 42, size: { width: 256, height: 256 }, parameters: { steps: 9 }, outputPath: sourceImage, sidecar: true });
      if (result.status === 'refused') throw new Error(result.code);
      expect(result.maskMode).toBeUndefined();
      expect((await sharp(sourceImage).stats()).channels.some(channel => channel.stdev > 1)).toBe(true);
      expect(result.effectiveParameters.steps).toBe(9);
    } finally { await generated.dispose(); }
    const original = await readFile(sourceImage);
    const mask = Buffer.alloc(256 * 256);
    for (let y = 48; y < 208; y++) for (let x = 64; x < 192; x++) mask[y * 256 + x] = Math.min(255, (Math.min(x - 64, 191 - x, y - 48, 207 - y) + 1) * 32);
    await sharp(mask, { raw: { width: 256, height: 256, channels: 1 } }).toColourspace('b-w').png().toFile(maskImage);
    const editor = createImageClient({ engineDirectory: testEngineDirectory, model: fill.model });
    try {
      const cancellation = new AbortController();
      const cancelledPath = join(directory, 'cancelled.png');
      await expect(editor.edit({ sourceImage, maskImage, instruction: 'A red ceramic vase.', seed: 42, parameters: { steps: 4 }, outputPath: cancelledPath }, {
        signal: cancellation.signal,
        onProgress: progress => { if (progress.stage === 'editing' && (progress.completed ?? 0) >= 1) cancellation.abort(); },
      })).rejects.toMatchObject({ code: 'CANCELLED' });
      expect(cancellation.signal.aborted).toBe(true);
      await expect(readFile(cancelledPath)).rejects.toMatchObject({ code: 'ENOENT' });
      const result = await editor.edit({ sourceImage, maskImage, instruction: 'A red ceramic vase on a pale wooden table, product photography.', seed: 42, parameters: { steps: 4 }, outputPath: join(directory, 'filled.png'), sidecar: true });
      if (result.status === 'refused') throw new Error(result.code);
      expect(result.maskMode).toBe('native');
      expect(result.record.maskMode).toBe('native');
      expect(result.effectiveParameters).toMatchObject({ steps: 4, guidance: 30 });
      expect(result.image.size).toEqual({ width: 256, height: 256 });
      expect((await sharp(result.image.path).stats()).channels.some(channel => channel.stdev > 1)).toBe(true);
      expect(await sharp(result.image.path).raw().toBuffer()).not.toEqual(await sharp(sourceImage).raw().toBuffer());
      expect(await readFile(result.sidecar!.path, 'utf8')).not.toContain(directory);
      // Native conditioning promises neither exact outside pixels nor a color-only edit.
      expect(await readFile(sourceImage)).toEqual(original);
    } finally { await editor.dispose(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 900_000);
