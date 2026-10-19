import { resolve } from 'node:path';
import { createImageClient, prepareModel } from 'picpatchsdk';

// node examples/structural-control.ts sd15|sdxl MODEL_DIR CHECKPOINT CONTROLNET SD_CLI canny|depth|pose MAP OUTPUT
// Map pixels must already match the chosen training modality and output size.
// Component names are bundle-relative; caller-owned file arguments are made absolute here.
const [variant, directory, checkpoint, controlNet, executable, kind, map, output] = process.argv.slice(2);
if (!['sd15', 'sdxl'].includes(variant ?? '') || !directory || !checkpoint || !controlNet || !executable || !map || !output || !['canny', 'depth', 'pose'].includes(kind ?? '')) {
  throw new Error('Supply a base variant, bundle, checkpoint, matching ControlNet, native executable, map kind, prepared map and output.');
}
const prepared = await prepareModel(variant!, {
  directory: resolve(directory), checkpoint,
  controlNet: { path: controlNet, kind: kind as 'canny' | 'depth' | 'pose' },
});
const editor = createImageClient({ model: prepared.model, nativeExecutable: resolve(executable) });
try {
  const result = await editor.generate({
    prompt: 'A ceramic sculpture in soft studio lighting.',
    control: { kind: kind as 'canny' | 'depth' | 'pose', image: resolve(map), strength: 0.9 },
    outputPath: resolve(output), size: { width: 512, height: 512 }, seed: 42,
    parameters: { sampler: 'dpm++2m', scheduler: 'karras', steps: 20 }, sidecar: {},
  });
  if ('status' in result) throw new Error(result.code);
  console.log(JSON.stringify({ image: result.image, control: result.control, parameters: result.effectiveParameters }));
} finally { await editor.dispose(); }
