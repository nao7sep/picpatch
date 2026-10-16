import { createEditor, PicPatchUsageError } from 'picpatch';
import { resolve } from 'node:path';

const pythonExecutable = process.argv[2];
if (!pythonExecutable) throw new Error('Pass the absolute path to an existing Python interpreter with worker dependencies installed.');
const editor = createEditor({ pythonExecutable });
try {
  await editor.edit({
    model: 'model-to-be-selected-after-evaluation',
    instruction: 'Change the background to a garden.',
    sourceImage: resolve('source.png'),
    outputPath: resolve('edited.png'),
  });
} catch (error) {
  // The current worker advertises no editing models. This example only exercises startup.
  if (error instanceof PicPatchUsageError && error.code === 'UNSUPPORTED_CAPABILITY') {
    console.log('Worker started successfully; no editing models are available.');
  } else throw error;
} finally {
  await editor.dispose();
}
