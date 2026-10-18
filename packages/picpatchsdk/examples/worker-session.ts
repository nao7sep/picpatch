import { createEditor, PicPatchUsageError } from 'picpatchsdk';
import { resolve } from 'node:path';

const engineDirectory = process.argv[2];
const sourceImage = process.argv[3];
const outputPath = process.argv[4];
if (!engineDirectory || !sourceImage || !outputPath) throw new Error('Pass an absolute managed engine directory, a source image, and an unused PNG output path.');
const editor = createEditor({ engineDirectory });
try {
  await editor.edit({
    model: 'model-to-be-selected-after-evaluation',
    instruction: 'Change the background to a garden.',
    sourceImage: resolve(sourceImage),
    outputPath: resolve(outputPath),
  });
} catch (error) {
  // The current worker advertises no editing models. This example exercises input preparation and startup.
  if (error instanceof PicPatchUsageError && error.code === 'UNSUPPORTED_CAPABILITY') {
    console.log('Worker started successfully; no editing models are available.');
  } else throw error;
} finally {
  await editor.dispose();
}
