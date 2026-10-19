import { readFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createImageClient, type ImageClientOptions } from 'picpatchsdk';

// Supply the configuration written by scripts/prepare-inference.ts and a fresh output directory.
const [configuration, destination] = process.argv.slice(2);
if (!configuration || !destination) throw new Error('Supply a prepared configuration JSON and output directory.');
const options = JSON.parse(await readFile(resolve(configuration), 'utf8')) as ImageClientOptions;
const output = resolve(destination);
await mkdir(output, { recursive: true });
// Full-resolution Base inference can exceed the SDK's ordinary operation deadline.
const editor = createImageClient({ ...options, timeouts: { ...options.timeouts, generateMs: 7_200_000, editMs: 7_200_000 } });
const started = performance.now();
const onProgress = (event: { stage: string; completed?: number; total?: number }) => {
  console.log(((performance.now() - started) / 1000).toFixed(3), event.stage, event.completed ?? '', event.total ?? '');
};
try {
  const generated = await editor.generate({
    prompt: 'A professional product photograph of a single forest-green enamel camping mug with a cream rim and a curved handle, resting on a pale oak table beside a folded linen napkin. Soft morning window light, realistic enamel reflections, subtle wear along the rim, shallow depth of field, clean thoughtful composition, no text or logos.',
    seed: 42, size: { width: 1024, height: 1024 }, outputPath: join(output, 'mug-original.png'), sidecar: {},
  }, { onProgress });
  if ('status' in generated) throw new Error(generated.code);
  console.log('Saved', generated.image.path);
  const edited = await editor.edit({
    sourceImage: generated.image.path,
    instruction: 'Keep the exact same forest-green enamel mug, cream rim, handle shape and camera angle. Replace the indoor setting with a weathered wooden picnic table beside a calm mountain lake at sunrise. Remove the napkin. Use realistic warm sunrise lighting and distant mountains softly out of focus. Professional outdoor product photography.',
    seed: 42, outputPath: join(output, 'mug-lakeside.png'), sidecar: {},
  }, { onProgress });
  if ('status' in edited) throw new Error(edited.code);
  console.log('Saved', edited.image.path);
} finally { await editor.dispose(); }
