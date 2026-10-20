import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import sharp from 'sharp';
import { createImageClient, prepareModel } from 'picpatchsdk';

// node examples/generate-and-fill.ts ENGINE_DIR Z_IMAGE_BUNDLE FILL_BUNDLE OUTPUT_DIR
// Uses the pinned Q4 local bundles; this example never downloads models.
const [engine, generationBundle, fillBundle, destination] = process.argv.slice(2);
if (!engine || !generationBundle || !fillBundle || !destination) throw new Error('Supply an engine, Z-Image Turbo bundle, FLUX Fill bundle and output directory.');
const engineDirectory = resolve(engine);
const output = resolve(destination);
await mkdir(output, { recursive: true });
const sourceImage = join(output, 'source.png');
const maskImage = join(output, 'mask.png');
const model = (await prepareModel('z-image-turbo-4bit', { directory: resolve(generationBundle) })).model;
const generator = createImageClient({ engineDirectory, model, timeouts: { generateMs: 1_200_000 } });
try {
  const result = await generator.generate({
    prompt: 'A professional product photograph of a small blue ceramic vase on a pale oak table, centered with empty space around it. Soft window light, realistic ceramic glaze, no text or logos.',
    size: { width: 512, height: 512 }, seed: 42, parameters: { steps: 9 }, outputPath: sourceImage, sidecar: true,
  });
  if (result.status === 'refused') throw new Error(result.code);
} finally { await generator.dispose(); }
// Caller-owned mask: opaque grayscale, white edits, with a softened rectangular edge.
const mask = Buffer.alloc(512 * 512);
for (let y = 64; y < 448; y++) for (let x = 128; x < 384; x++) {
  mask[y * 512 + x] = Math.min(255, (Math.min(x - 128, 383 - x, y - 64, 447 - y) + 1) * 16);
}
// Exclusive caller-side publication also protects an existing example mask.
await writeFile(maskImage, await sharp(mask, { raw: { width: 512, height: 512, channels: 1 } }).toColourspace('b-w').png().toBuffer(), { flag: 'wx' });
const fill = (await prepareModel('flux1-fill-dev-4bit', { directory: resolve(fillBundle) })).model;
const editor = createImageClient({ engineDirectory, model: fill, timeouts: { editMs: 1_200_000 } });
try {
  const result = await editor.edit({
    sourceImage, maskImage, instruction: 'A small terracotta vase holding three white daisies on a pale oak table. Professional product photography, soft window light, realistic shadows.',
    size: { width: 512, height: 512 }, seed: 42, parameters: { steps: 25 }, outputPath: join(output, 'filled.png'), sidecar: true,
  });
  if (result.status === 'refused') throw new Error(result.code);
  console.log(JSON.stringify({ image: result.image.path, maskMode: result.maskMode, sidecar: result.sidecar }));
  // Native Fill may change pixels outside the mask; it does not final-composite the source.
} finally { await editor.dispose(); }
