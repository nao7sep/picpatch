import type { EditResult } from '../../src/contracts.generated.ts';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { listModels, validateEditRequest, validateGenerateRequest, type EditRequest } from '../../src/index.ts';
import { ImageWorkspace } from '../../src/images/output.ts';
import { ImageClientImpl } from '../../src/execution/session.ts';
import type { EditBackend } from '../../src/execution/backend.ts';

let directory: string;
let request: EditRequest;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'picpatch-outpaint-'));
  const sourceImage = join(directory, 'source.png');
  await sharp({ create: { width: 13, height: 9, channels: 4, background: { r: 50, g: 90, b: 130, alpha: 0.5 } } }).png().toFile(sourceImage);
  request = { model: 'flux2-klein-4b', instruction: 'Extend the background.', sourceImage, outputPath: join(directory, 'out.png'), outpaint: { size: { width: 32, height: 16 }, left: 3, top: 2 } };
});
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

it('builds an asymmetric canvas with exact source pixels and an opaque binary mask', async () => {
  const original = await readFile(request.sourceImage!);
  const work = await ImageWorkspace.create(request);
  try {
    await work.prepare(undefined, 'klein-reference', 'composite');
    const prepared = work.workerRequest as EditRequest;
    expect(prepared).not.toHaveProperty('outpaint');
    expect(prepared.size).toEqual(request.outpaint!.size);
    const source = await sharp(request.sourceImage!).ensureAlpha().raw().toBuffer();
    const expanded = await sharp(prepared.sourceImage!).ensureAlpha().raw().toBuffer();
    expect(await sharp(prepared.maskImage!).metadata()).toMatchObject({ space: 'b-w', hasAlpha: false });
    const mask = await sharp(prepared.maskImage!).toColourspace('b-w').raw().toBuffer({ resolveWithObject: true });
    expect(mask.info.channels).toBe(1);
    for (let y = 0; y < 16; y++) for (let x = 0; x < 32; x++) {
      const inside = x >= 3 && x < 16 && y >= 2 && y < 11;
      expect(mask.data[y * 32 + x]).toBe(inside ? 0 : 255);
      if (inside) expect(expanded.subarray((y * 32 + x) * 4, (y * 32 + x + 1) * 4)).toEqual(source.subarray(((y - 2) * 13 + x - 3) * 4, ((y - 2) * 13 + x - 2) * 4));
    }
    expect(await readFile(request.sourceImage!)).toEqual(original);
  } finally { await work.cleanup(); }
});

it('uses oriented source dimensions without applying the reference crop policy', async () => {
  await sharp({ create: { width: 9, height: 13, channels: 3, background: 'red' } }).withMetadata({ orientation: 6 }).png().toFile(request.sourceImage!);
  const work = await ImageWorkspace.create(request);
  try {
    await work.prepare(undefined, 'klein-reference');
    expect(await sharp(work.workerRequest.sourceImage!).metadata()).toMatchObject({ width: 32, height: 16 });
  } finally { await work.cleanup(); }
});

it.each([
  { size: { width: 12, height: 8 }, left: 0, top: 0 },
  { size: { width: 13, height: 9 }, left: 0, top: 0 },
  { size: { width: 32, height: 16 }, left: 20, top: 0 },
])('rejects a canvas that cannot expand the source: %j', async outpaint => {
  const work = await ImageWorkspace.create({ ...request, outpaint });
  try { await expect(work.prepare()).rejects.toMatchObject({ code: 'INVALID_REQUEST' }); }
  finally { await work.cleanup(); }
});

it('rejects unsupported models, masks, dimensions and malformed placement before image reads', () => {
  const klein = listModels().find(model => model.id === request.model)!.capabilities;
  expect(() => validateEditRequest(request, klein)).not.toThrow();
  for (const outpaint of [null, { ...request.outpaint, left: -1 }, { ...request.outpaint, top: 0.5 }]) {
    expect(() => validateEditRequest({ ...request, outpaint }, klein)).toThrow();
  }
  for (const extra of [{ sourceImage: undefined }, { maskImage: '/mask.png' }, { size: { width: 16, height: 16 } }]) {
    expect(() => validateEditRequest({ ...request, ...extra }, klein)).toThrow();
  }
  for (const size of [{ width: 31, height: 16 }, { width: 2048, height: 2048 }]) {
    expect(() => validateEditRequest({ ...request, outpaint: { ...request.outpaint, size } }, klein)).toThrow();
  }
  const noMask = listModels().find(model => model.id === 'flux1-kontext-dev')!.capabilities;
  expect(() => validateEditRequest({ ...request, model: noMask.model }, noMask)).toThrow();
  const fill = listModels().find(model => model.id === 'flux1-fill-dev')!.capabilities;
  expect(() => validateEditRequest({ ...request, model: fill.model }, fill)).not.toThrow();
  expect(() => validateGenerateRequest({ model: request.model, prompt: 'Blue', outputPath: request.outputPath, outpaint: request.outpaint })).toThrow();
});

it('publishes geometry and path-free sidecar through the session, and cleans cancellation', async () => {
  const caps = listModels().find(model => model.id === request.model)!.capabilities;
  const execute = vi.fn(async (prepared: EditRequest): Promise<EditResult> => {
    expect(prepared).not.toHaveProperty('outpaint');
    validateEditRequest(prepared, caps);
    await sharp(prepared.sourceImage!).png().toFile(prepared.outputPath);
    return { model: request.model, modelRevision: 'test', runtime: { name: 'test', version: '1' }, seed: 42, effectiveParameters: {}, references: [], image: { path: prepared.outputPath, mimeType: 'image/png', size: prepared.size! } };
  });
  const backend: EditBackend = { validate: async r => { validateEditRequest(r, caps); return caps; }, edit: execute, generate: async () => { throw new Error('Unexpected generation'); }, dispose: async () => {} };
  const editor = new ImageClientImpl(backend);
  try {
    const saved = await editor.edit({ ...request, sidecar: { includeInputs: true } });
    if ('status' in saved) throw new Error(saved.code);
    expect(saved.outpaint).toEqual({ ...request.outpaint, sourceSize: { width: 13, height: 9 } });
    expect(saved.inputGeometry?.[0]?.preparedSize).toEqual({ width: 13, height: 9 });
    const json = await readFile(saved.sidecar!.path, 'utf8');
    expect(JSON.parse(json).outpaint).toEqual(saved.outpaint);
    expect(json).not.toContain(directory);
    await expect(editor.edit({ ...request, outputPath: join(directory, 'cancelled.png') }, { signal: AbortSignal.abort() })).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(execute).toHaveBeenCalledTimes(1);
    expect((await readdir(directory)).some(name => name.startsWith('.picpatch-'))).toBe(false);
  } finally { await editor.dispose(); }
});

it('preserves every source pixel and marks exactly the added area across generated asymmetric canvases', async () => {
  const source = await sharp(request.sourceImage!).ensureAlpha().raw().toBuffer();
  for (let index = 0; index < 12; index++) {
    const left = index % 5; const top = (index * 3) % 4;
    const width = 13 + left + 1 + index % 7; const height = 9 + top + 1 + index % 3;
    const work = await ImageWorkspace.create({ ...request, outputPath: join(directory, `result-${index}.png`), outpaint: { size: { width, height }, left, top } });
    try {
      await work.prepare();
      const pixels = await sharp(work.workerRequest.sourceImage!).ensureAlpha().raw().toBuffer();
      const mask = await sharp(work.workerRequest.maskImage!).toColourspace('b-w').raw().toBuffer();
      let preserved = 0;
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const inside = x >= left && x < left + 13 && y >= top && y < top + 9;
        expect(mask[y * width + x]).toBe(inside ? 0 : 255);
        if (inside) { preserved++; expect(pixels.subarray((y * width + x) * 4, (y * width + x + 1) * 4)).toEqual(source.subarray(((y - top) * 13 + x - left) * 4, ((y - top) * 13 + x - left + 1) * 4)); }
      }
      expect(preserved).toBe(13 * 9);
    } finally { await work.cleanup(); }
  }
});
