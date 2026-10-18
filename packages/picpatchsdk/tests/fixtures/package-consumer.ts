// Copied outside the checkout by the package gate. Only public SDK exports are available.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import sharp from 'sharp';
import { createEditor, prepareModel, discoverModels, resolveStoragePaths, type EditResult } from 'picpatchsdk';

const config = JSON.parse(await readFile(process.argv[2]!, 'utf8')) as {
  engineDirectory: string; modelId: string; outputDirectory: string; modelsDirectory: string;
  native: { directory: string; executable: string; checkpoint: string; photoMaker: string; sd15InpaintCheckpoint: string };
};
assert.equal(resolveStoragePaths({ modelsDirectory: config.modelsDirectory }).modelsDirectory, config.modelsDirectory);
assert.equal((await discoverModels([config.modelsDirectory])).models.length, 1);
// Explicit opt-in still reuses the verified cache without attempting a network request.
const prepared = await prepareModel(config.modelId, { download: true, storage: { modelsDirectory: config.modelsDirectory } });
assert.equal(prepared.origin, 'cache');
const defaults = { outputDirectory: config.outputDirectory, size: { width: 256, height: 256 }, seed: 42 };
async function artifact(result: EditResult) {
  assert.equal(result.sidecar?.status, 'saved');
  const bytes = await readFile(result.image.path);
  const text = await readFile(result.sidecar!.path, 'utf8');
  const record = JSON.parse(text);
  assert.equal(record.image.filename, basename(result.image.path));
  assert.equal(record.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(record.bytes, bytes.length);
  for (const path of [config.outputDirectory, config.modelsDirectory, config.native.directory]) assert.ok(!text.includes(path));
  const metadata = await sharp(bytes).metadata();
  assert.equal(metadata.width, 256); assert.equal(metadata.height, 256);
  assert.ok((await sharp(bytes).stats()).channels.some(channel => channel.stdev > 1));
  return record;
}
const editor = createEditor({ engineDirectory: config.engineDirectory, model: prepared.model, defaults });
let source: string;
try {
  const generated = await editor.generate({ prompt: 'A blue ceramic bowl on a white table.', parameters: { steps: 2 }, sidecar: {} });
  if ('status' in generated) throw new Error(generated.code);
  const record = await artifact(generated);
  assert.equal(record.effectiveParameters.steps, 2); assert.equal(record.inputs, undefined);
  source = generated.image.path;
  const edited = await editor.edit({ instruction: 'Make the bowl green.', sourceImage: source, parameters: { steps: 2 }, sidecar: { includeInputs: true } });
  if ('status' in edited) throw new Error(edited.code);
  assert.equal((await artifact(edited)).inputs.sourceImage, basename(source));
} finally { await editor.dispose(); }
const original = await readFile(source!);
const maskImage = join(config.outputDirectory, 'mask.png');
await sharp({ create: { width: 256, height: 256, channels: 3, background: 'white' } }).toColourspace('b-w').png().toFile(maskImage);
const masked = await prepareModel('sd15-inpaint', { directory: config.native.directory, checkpoint: config.native.sd15InpaintCheckpoint });
assert.equal(masked.origin, 'external');
assert.equal(masked.integrity, 'locally-fingerprinted');
const inpaint = createEditor({ nativeExecutable: config.native.executable, model: masked.model, defaults });
try {
  const result = await inpaint.edit({ instruction: 'A red ceramic bowl on a white table.', sourceImage: source!, maskImage, parameters: { steps: 4 }, sidecar: { includeInputs: true } });
  if ('status' in result) throw new Error(result.code);
  const record = await artifact(result);
  assert.equal(record.inputs.maskImage, basename(maskImage));
  assert.equal(record.effectiveParameters.strength, 1);
} finally { await inpaint.dispose(); }
const identity = await prepareModel('sdxl-photomaker-v1', { directory: config.native.directory, checkpoint: config.native.checkpoint, photoMaker: config.native.photoMaker });
const conditioned = createEditor({ nativeExecutable: config.native.executable, model: identity.model, defaults });
try {
  // A neutral generated fixture proves API/asset transport, not portrait identity quality.
  const result = await conditioned.edit({ instruction: 'A watercolor portrait of {person}.', references: [
    { id: 'person', role: 'subject', conditioning: 'identity', className: 'man', images: [source!] },
  ], parameters: { steps: 4, identityStyleStrength: 25 }, sidecar: {} });
  if ('status' in result) throw new Error(result.code);
  const record = await artifact(result);
  assert.equal(record.conditioning.method, 'photomaker-v1');
  assert.equal(record.conditioning.assets[0].filename, basename(config.native.photoMaker));
  assert.equal(record.effectiveParameters.identityStyleStrength, 25);
} finally { await conditioned.dispose(); }
assert.deepEqual(await readFile(source!), original);
assert.ok(!(await readdir(config.outputDirectory)).some(name => name.startsWith('.picpatch-')));
console.log('inference consumer passed');
