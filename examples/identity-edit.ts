import { resolve } from 'node:path';
import { createEditor, prepareModel } from 'picpatch';

// npx tsx examples/identity-edit.ts MODEL_DIR CHECKPOINT PHOTOMAKER SD_CLI OUTPUT PHOTO [PHOTO...]
const [directory, checkpoint, photoMaker, executable, output, ...photos] = process.argv.slice(2);
if (!directory || !checkpoint || !photoMaker || !executable || !output || !photos.length) {
  throw new Error('Supply model directory, relative checkpoint/PhotoMaker files, executable, output and photos of one person.');
}
const prepared = await prepareModel('sdxl-photomaker-v1', { directory: resolve(directory), checkpoint, photoMaker });
const editor = createEditor({ model: prepared.model, nativeExecutable: resolve(executable) });
try {
  const result = await editor.edit({
    instruction: 'A studio portrait of {person}, wearing a blue jacket.',
    references: [{ id: 'person', role: 'subject', conditioning: 'identity', className: 'man', images: photos.map(photo => resolve(photo)) as [string, ...string[]] }],
    outputPath: resolve(output), sidecar: {},
  });
  console.log(JSON.stringify({ image: result.image, conditioning: result.conditioning }));
} finally { await editor.dispose(); }
