import { testEngineDirectory } from '../helpers/engine.ts';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { copyFile, mkdtemp, mkdir, readFile, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import sharp from 'sharp';
import { expect, it } from 'vitest';
import { createImageClient, prepareModel, type ImageClientOptions } from 'picpatchsdk';
import { liveCacheRoot, inferenceConfig, nativeInferenceConfigPath } from '../helpers/live-cache.ts';
const assets: { family: string; filename: string; bytes: number; sha256: string; scale: number; steps: number }[] = JSON.parse(await readFile(new URL('../fixtures/trained-lora-assets.json', import.meta.url), 'utf8'));

const cache = liveCacheRoot;
it.each(assets)('applies the pinned trained $family pixel-art adapter through the public SDK', async asset => {
  const adapter = join(process.env.PICPATCH_TRAINED_LORA_DIRECTORY ?? join(cache, 'trained-loras'), asset.filename);
  expect((await stat(adapter)).size).toBe(asset.bytes);
  expect(await digest(adapter)).toBe(asset.sha256);
  const directory = await mkdtemp(join(tmpdir(), 'picpatch-trained-lora-'));
  try {
    let options: ImageClientOptions;
    if (asset.family === 'klein') {
      const config: ImageClientOptions = await inferenceConfig();
      for (const component of config.model!.manifest.components) {
        const target = join(directory, component.path);
        await mkdir(dirname(target), { recursive: true });
        await symlink(join(config.model!.directory, component.path), target);
      }
      await symlink(resolve(adapter), join(directory, asset.filename));
      const prepared = await prepareModel(config.model!.manifest.model, { directory, loras: [{ path: asset.filename }] });
      options = { engineDirectory: testEngineDirectory, model: prepared.model };
    } else {
      const config = JSON.parse(await readFile(nativeInferenceConfigPath(), 'utf8'));
      await symlink(join(config.directory, config.checkpoint), join(directory, 'base.safetensors'));
      await symlink(resolve(adapter), join(directory, asset.filename));
      const prepared = await prepareModel('sdxl', { directory, checkpoint: 'base.safetensors', loras: [{ path: asset.filename }] });
      options = { nativeExecutable: config.executable, model: prepared.model };
    }
    const pixels: Buffer[] = [];
    for (const scale of [0, asset.scale]) {
      const editor = createImageClient({ ...options, model: { ...options.model!, loras: [{ path: asset.filename, scale }] }, defaults: { size: { width: 512, height: 512 }, seed: 42, outputDirectory: directory } });
      try {
        const result = await editor.generate({ prompt: 'pixel art sprite, a small friendly blue robot with glowing eyes, game asset, plain white background', parameters: { steps: asset.steps }, sidecar: true });
        if (result.status === 'refused') throw new Error(result.code);
        expect(result.loras).toEqual([{ filename: asset.filename, sha256: asset.sha256, scale }]);
        const sidecar = await readFile(result.sidecar!.path, 'utf8');
        expect(sidecar).not.toContain(directory);
        expect(JSON.parse(sidecar).loras).toEqual(result.loras);
        expect((await sharp(result.image.path).stats()).channels.some(channel => channel.stdev > 5)).toBe(true);
        pixels.push(await sharp(result.image.path).removeAlpha().raw().toBuffer());
        // Optional caller-owned evidence directory; ordinary gate runs leave no artifacts.
        if (process.env.PICPATCH_LORA_EVIDENCE_DIRECTORY) {
          await mkdir(process.env.PICPATCH_LORA_EVIDENCE_DIRECTORY, { recursive: true });
          await copyFile(result.image.path, join(process.env.PICPATCH_LORA_EVIDENCE_DIRECTORY, `${asset.family}-${scale}.png`));
        }
      } finally { await editor.dispose(); }
    }
    expect(pixels[0]!.equals(pixels[1]!)).toBe(false);
    expect(await digest(adapter)).toBe(asset.sha256);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

async function digest(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
