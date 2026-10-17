import { resolve } from 'node:path';
import { createEditor, prepareModel } from 'picpatch';

// npx tsx examples/source-variation.ts sd15|sdxl MODEL_DIR CHECKPOINT SD_CLI SOURCE OUTPUT [STRENGTH]
const [variant, directory, checkpoint, executable, source, output, strength] = process.argv.slice(2);
if (!['sd15', 'sdxl'].includes(variant ?? '') || !directory || !checkpoint || !executable || !source || !output) {
  throw new Error('Supply variant, model directory, relative checkpoint, executable, source, output and optional strength.');
}
const prepared = await prepareModel(variant!, { directory: resolve(directory), checkpoint });
const editor = createEditor({ model: prepared.model, nativeExecutable: resolve(executable) });
try {
  const result = await editor.edit({
    instruction: 'A watercolor painting with soft blue tones.',
    sourceImage: resolve(source), outputPath: resolve(output),
    ...(strength === undefined ? {} : { parameters: { strength: Number(strength) } }),
  });
  console.log(JSON.stringify({ image: result.image, parameters: result.effectiveParameters }));
} finally { await editor.dispose(); }
