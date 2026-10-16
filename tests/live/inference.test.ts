import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { expect, it } from 'vitest';
import { createEditor, type EditorOptions } from '../../src/index.ts';

it('edits grouped references twice through the offline public adapter and disposes the worker', async () => {
  const path = process.env.PICPATCH_INFERENCE_CONFIG;
  if (!path) throw new Error('Real inference requires PICPATCH_INFERENCE_CONFIG: an absolute JSON file containing EditorOptions with a prepared MFLUX 0.22.0 interpreter and local model manifest. This test never downloads models.');
  const options = JSON.parse(await readFile(path, 'utf8')) as EditorOptions;
  if (!options.model) throw new Error('PICPATCH_INFERENCE_CONFIG must include a local model configuration.');
  const editor = createEditor(options);
  const directory = await mkdtemp(join(tmpdir(), 'picpatch-inference-'));
  try {
    const images = [join(directory, 'red.png'), join(directory, 'blue.png')];
    await sharp({ create: { width: 256, height: 256, channels: 3, background: 'red' } }).png().toFile(images[0]!);
    await sharp({ create: { width: 256, height: 256, channels: 3, background: 'blue' } }).png().toFile(images[1]!);
    for (let index = 0; index < 2; index++) {
      const result = await editor.edit({ model: options.model.manifest.model,
        instruction: 'Combine both colors into a simple striped image.',
        references: [{ id: 'colors', role: 'style', images: [images[0]!, images[1]!] }],
        size: { width: 256, height: 256 }, seed: 42, outputPath: join(directory, `edit-${index}.png`) });
      const metadata = await sharp(result.image.path).metadata();
      expect(metadata).toMatchObject({ format: 'png', width: 256, height: 256 });
      expect(result.runtime).toEqual({ name: 'mflux', version: '0.22.0' });
      expect(result.seed).toBe(42);
    }
  } finally {
    await editor.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}, 3_600_000);
