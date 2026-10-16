import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { expect, it } from 'vitest';
import { createEditor, type EditorOptions } from '../../src/index.ts';

async function localOptions(): Promise<EditorOptions> {
  const path = process.env.PICPATCH_INFERENCE_CONFIG ?? fileURLToPath(new URL('../../node_modules/.cache/picpatch-live/inference-config.json', import.meta.url));
  let options: EditorOptions;
  try { options = JSON.parse(await readFile(path, 'utf8')) as EditorOptions; }
  catch (cause) { throw new Error('Prepare the local inference test cache or set PICPATCH_INFERENCE_CONFIG to an editor-options JSON file. This test never downloads models.', { cause }); }
  if (!options.model) throw new Error('PICPATCH_INFERENCE_CONFIG must include a local model configuration.');
  return options;
}

it('edits grouped references and a source image sequentially through the offline public adapter', async () => {
  const options = await localOptions();
  const editor = createEditor(options);
  const directory = await mkdtemp(join(tmpdir(), 'picpatch-inference-'));
  try {
    const images = [join(directory, 'red.png'), join(directory, 'blue.png')];
    await sharp({ create: { width: 256, height: 256, channels: 3, background: 'red' } }).png().toFile(images[0]!);
    await sharp({ create: { width: 256, height: 256, channels: 3, background: 'blue' } }).png().toFile(images[1]!);
    for (let index = 0; index < 2; index++) {
      const result = await editor.edit({ model: options.model!.manifest.model,
        instruction: 'Combine both colors into a simple striped image.',
        ...(index === 1 ? { sourceImage: join(directory, 'edit-0.png') } : {}),
        references: [{ id: 'colors', role: 'style', images: [images[0]!, images[1]!] }],
        size: { width: 256, height: 256 }, seed: 42, outputPath: join(directory, `edit-${index}.png`) });
      const metadata = await sharp(result.image.path).metadata();
      expect(metadata).toMatchObject({ format: 'png', width: 256, height: 256 });
      expect(result.runtime).toEqual({ name: 'mflux', version: '0.22.0' });
      expect(result.seed).toBe(42);
      expect(result.modelRevision).toBe(options.model!.manifest.source.revision);
      expect(result.references[0]?.images).toEqual(images);
    }
  } finally {
    await editor.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}, 3_600_000);

it('cancels after a real denoising step and cleans unpublished output after worker settlement', async () => {
  const options = await localOptions();
  const editor = createEditor(options);
  const directory = await mkdtemp(join(tmpdir(), 'picpatch-cancel-inference-'));
  try {
    const sourceImage = join(directory, 'source.png');
    await sharp({ create: { width: 256, height: 256, channels: 3, background: 'red' } }).png().toFile(sourceImage);
    const controller = new AbortController();
    let sawStep = false;
    await expect(editor.edit({ model: options.model!.manifest.model, instruction: 'Make the image blue.',
      sourceImage, size: { width: 256, height: 256 }, seed: 42, outputPath: join(directory, 'cancelled.png'),
    }, { signal: controller.signal, onProgress: event => {
      if (event.stage === 'editing' && event.completed !== undefined && event.completed >= 1) {
        sawStep = true;
        controller.abort();
      }
    } })).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(sawStep).toBe(true);
    await editor.dispose();
    expect(await readdir(directory)).toEqual(['source.png']);
  } finally {
    await editor.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}, 1_800_000);
