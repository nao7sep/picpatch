import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createEditor, listModels, prepareModel, validateGenerateRequest } from 'picpatchsdk';
import { ImageWorkspace } from '../../src/images/output.ts';
import { controlNetShapes, nativeCheckpoint, tensorFile } from '../helpers/native-assets.ts';
let directory: string;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'picpatch-control-')); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
const controlNet = { path: 'canny.safetensors', kind: 'canny' as const };
it.each(['canny', 'depth', 'pose'] as const)('fingerprints compatible %s auxiliary weights without altering them', async kind => {
  const controlNet = { path: `${kind}.safetensors`, kind };
  await nativeCheckpoint(join(directory, 'base.safetensors'), 'sd15');
  await tensorFile(join(directory, controlNet.path), controlNetShapes());
  const original = await readFile(join(directory, controlNet.path));
  const prepared = await prepareModel('sd15', { directory, checkpoint: 'base.safetensors', controlNet });
  expect(prepared.model.controlNet).toEqual(controlNet);
  expect(prepared.model.manifest.components).toHaveLength(2);
  expect(await readFile(join(directory, controlNet.path))).toEqual(original);
});
it.each(['sd15-inpaint', 'sd15-ip-adapter', 'wrong-context', 'missing-hint'])('rejects incompatible %s before hashing', async failure => {
  const variant = failure.startsWith('sd') ? failure : 'sd15';
  await nativeCheckpoint(join(directory, 'base.safetensors'), variant);
  const shapes = controlNetShapes(failure === 'wrong-context' ? 2048 : 768);
  if (failure === 'missing-hint') delete shapes['control_model.input_hint_block.0.weight'];
  await tensorFile(join(directory, controlNet.path), shapes);
  const onProgress = vi.fn();
  await expect(prepareModel(variant, { directory, checkpoint: 'base.safetensors', controlNet, onProgress })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  expect(onProgress).not.toHaveBeenCalled();
});
it('rejects unsupported maps and malformed capability metadata before input IO', async () => {
  const caps = listModels().find(item => item.id === 'sd15')!.capabilities;
  const request = { model: 'sd15', prompt: 'A bowl.', outputPath: '/out.png', control: { kind: 'canny', image: '/map.png' } };
  expect(() => validateGenerateRequest(request, caps)).not.toThrow();
  for (const control of [{ kind: 'unknown', image: '/map.png' }, { kind: 'canny', image: 'relative.png' }, { kind: 'canny', image: '/map.png', strength: -1 }, { kind: 'canny', image: '/map.png', strength: Infinity }]) expect(() => validateGenerateRequest({ ...request, control }, caps)).toThrow();
  expect(() => validateGenerateRequest({ ...request, outputPath: '/map.png' }, caps)).toThrow(expect.objectContaining({ code: 'OUTPUT_CONFLICT' }));
  expect(() => validateGenerateRequest(request, { ...caps, controlKinds: {} } as never)).toThrow(expect.objectContaining({ code: 'INVALID_CAPABILITIES' }));
  for (const model of ['sdxl-inpaint', 'flux2-klein-4b']) expect(() => validateGenerateRequest({ ...request, model }, listModels().find(item => item.id === model)!.capabilities)).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_CAPABILITY' }));
  await nativeCheckpoint(join(directory, 'base.safetensors'), 'sd15');
  const prepared = await prepareModel('sd15', { directory, checkpoint: 'base.safetensors' });
  const editor = createEditor({ model: prepared.model, nativeExecutable: '/missing-executable' });
  try { await expect(editor.generate(request as never)).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' }); }
  finally { await editor.dispose(); }
});
it.each(['valid', 'orientation', 'wrong-size', 'alpha', 'jpeg', 'cancel'])('prepares %s maps privately without resizing or mutating callers', async mode => {
  const image = join(directory, 'map.png');
  let pipeline = sharp(Buffer.alloc(16 * 8, 255), { raw: { width: 16, height: 8, channels: 1 } }).toColourspace('b-w');
  if (mode === 'alpha') pipeline = pipeline.ensureAlpha();
  pipeline = mode === 'jpeg' ? pipeline.jpeg() : pipeline.png();
  if (mode === 'orientation') pipeline = pipeline.withMetadata({ orientation: 6 });
  await pipeline.toFile(image);
  const original = await readFile(image);
  const size = mode === 'orientation' ? { width: 8, height: 16 } : { width: 16, height: 8 };
  const workspace = await ImageWorkspace.create({ model: 'sd15', prompt: 'A bowl.', outputPath: join(directory, 'out.png'), control: { kind: 'canny', image } });
  try {
    const operation = workspace.prepare(mode === 'cancel' ? AbortSignal.abort() : undefined, undefined, 'none', mode === 'wrong-size' ? { width: 8, height: 8 } : size);
    if (['alpha', 'jpeg', 'wrong-size', 'cancel'].includes(mode)) await expect(operation).rejects.toMatchObject({ code: mode === 'wrong-size' ? 'INVALID_REQUEST' : mode === 'cancel' ? 'CANCELLED' : 'INVALID_IMAGE' });
    else {
      await operation;
      expect(workspace.workerRequest.size).toEqual(size);
      expect(workspace.workerRequest.control!.image).not.toBe(image);
      expect(await sharp(workspace.workerRequest.control!.image).metadata()).toMatchObject({ ...size, channels: 3 });
    }
  } finally { await workspace.cleanup(); }
  expect(await readFile(image)).toEqual(original);
  expect((await readdir(directory)).some(name => name.startsWith('.picpatch-'))).toBe(false);
});

it.each(['valid', 'sd15-weights', 'lightweight', 'missing-adm'])('checks SDXL ControlNet architecture for %s', async kind => {
  await nativeCheckpoint(join(directory, 'base.safetensors'), 'sdxl');
  const shapes = controlNetShapes(kind === 'sd15-weights' ? 768 : 2048);
  if (kind === 'lightweight') delete shapes['control_model.input_blocks.7.1.transformer_blocks.9.attn2.to_k.weight'];
  if (kind === 'missing-adm') delete shapes['control_model.label_emb.0.0.weight'];
  await tensorFile(join(directory, 'control.safetensors'), shapes);
  const prepare = prepareModel('sdxl', { directory, checkpoint: 'base.safetensors', controlNet: { path: 'control.safetensors', kind: 'depth' } });
  if (kind === 'valid') expect((await prepare).model.controlNet?.kind).toBe('depth');
  else await expect(prepare).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
});
