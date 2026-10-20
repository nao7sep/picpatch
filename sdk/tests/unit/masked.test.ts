import { mkdtemp, readdir, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { ImageWorkspace } from '../../src/images/output.ts';
let directory: string;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'picpatch-mask-')); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
async function fixture(width: number, height: number, orientation = 1) {
  const sourceImage = join(directory, 'source.png'); const maskImage = join(directory, 'mask.png');
  await sharp({ create: { width, height, channels: 4, background: '#80402080' } }).png().withMetadata({ orientation }).toFile(sourceImage);
  const w = orientation === 6 ? height : width; const h = orientation === 6 ? width : height;
  await sharp(Buffer.alloc(w * h, 128), { raw: { width: w, height: h, channels: 1 } }).toColourspace('b-w').png().toFile(maskImage);
  return { model: 'fixture', instruction: 'Use blue.', sourceImage, maskImage, outputPath: join(directory, 'out.png') };
}
it('aligns an oriented source and mask and derives output size without transforming mask edges', async () => {
  const work = await ImageWorkspace.create(await fixture(32, 48, 6));
  try {
    await work.prepare(undefined, 'klein-reference');
    expect(await sharp(work.workerRequest.maskImage!).metadata()).toMatchObject({ space: 'b-w', channels: 1 });
    expect(work.workerRequest.size).toEqual({ width: 48, height: 32 });
    expect(await sharp(work.workerRequest.sourceImage!).metadata()).toMatchObject({ width: 48, height: 32 });
    expect(await sharp(work.workerRequest.maskImage!).toColourspace('b-w').raw().toBuffer()).toEqual(Buffer.alloc(48 * 32, 128));
  } finally { await work.cleanup(); }
});
it.each([[33, 48], [2048, 1024]])('rejects masked sources requiring geometry changes (%s by %s)', async (width, height) => {
  const work = await ImageWorkspace.create(await fixture(width, height));
  try { await expect(work.prepare(undefined, 'klein-reference')).rejects.toMatchObject({ code: 'INVALID_MASK' }); }
  finally { await work.cleanup(); }
  expect((await readdir(directory)).sort()).toEqual(['mask.png', 'source.png']);
});
it('rejects output resizing and a mask that does not match the oriented source', async () => {
  const request = await fixture(32, 48);
  const work = await ImageWorkspace.create({ ...request, size: { width: 64, height: 64 } });
  try { await expect(work.prepare(undefined, 'klein-reference')).rejects.toMatchObject({ code: 'INVALID_MASK' }); }
  finally { await work.cleanup(); }
  await sharp(Buffer.alloc(16 * 16), { raw: { width: 16, height: 16, channels: 1 } }).toColourspace('b-w').png().toFile(request.maskImage);
  const mismatched = await ImageWorkspace.create(request);
  try { await expect(mismatched.prepare(undefined, 'klein-reference')).rejects.toMatchObject({ code: 'INVALID_MASK' }); }
  finally { await mismatched.cleanup(); }
});

it('keeps native mask/source snapshots aligned while accepting an explicit output resize', async () => {
  const work = await ImageWorkspace.create({ ...await fixture(33, 49, 6), size: { width: 64, height: 32 } });
  try {
    await work.prepare(undefined, undefined, 'native');
    expect(work.workerRequest.size).toEqual({ width: 64, height: 32 });
    expect(await sharp(work.workerRequest.sourceImage!).metadata()).toMatchObject({ width: 49, height: 33 });
    expect(await sharp(work.workerRequest.maskImage!).metadata()).toMatchObject({ width: 49, height: 33, space: 'b-w' });
  } finally { await work.cleanup(); }
});
it('defaults native output to source dimensions and rejects misaligned masks', async () => {
  const request = await fixture(32, 48);
  const work = await ImageWorkspace.create(request);
  try {
    await work.prepare(undefined, undefined, 'native');
    expect(work.workerRequest.size).toEqual({ width: 32, height: 48 });
  } finally { await work.cleanup(); }
  await sharp(Buffer.alloc(16 * 16), { raw: { width: 16, height: 16, channels: 1 } }).toColourspace('b-w').png().toFile(request.maskImage);
  const invalid = await ImageWorkspace.create(request);
  try { await expect(invalid.prepare(undefined, undefined, 'native')).rejects.toMatchObject({ code: 'INVALID_MASK' }); }
  finally { await invalid.cleanup(); }
});

it('keeps latent-composite masks aligned and rejects output resizing', async () => {
  const request = await fixture(32, 64, 6);
  const work = await ImageWorkspace.create(request);
  try {
    await work.prepare(undefined, undefined, 'latent-composite');
    expect(work.workerRequest.size).toEqual({ width: 64, height: 32 });
    expect(await sharp(work.workerRequest.maskImage!).toColourspace('b-w').raw().toBuffer()).toEqual(Buffer.alloc(64 * 32, 128));
  } finally { await work.cleanup(); }
  const resized = await ImageWorkspace.create({ ...request, size: { width: 64, height: 64 } });
  try { await expect(resized.prepare(undefined, undefined, 'latent-composite')).rejects.toMatchObject({ code: 'INVALID_MASK' }); }
  finally { await resized.cleanup(); }
});


it.each(['native', 'composite', 'latent-composite'] as const)('records the effective %s mechanism without input paths or runtime overrides', async maskMode => {
  const request = { ...await fixture(32, 48), sidecar: true };
  const workspace = await ImageWorkspace.create(request);
  try {
    await workspace.prepare(undefined, undefined, maskMode);
    await sharp({ create: { width: 32, height: 48, channels: 4, background: 'blue' } }).png().toFile(workspace.workerRequest.outputPath);
    const saved = await workspace.publish({ model: 'fixture', modelRevision: 'fixture', runtime: { name: 'test', version: '1' }, seed: 1, effectiveParameters: { steps: 1 }, references: [], maskMode: 'native', image: { path: workspace.workerRequest.outputPath, mimeType: 'image/png', size: { width: 32, height: 48 } } });
    expect(saved.maskMode).toBe(maskMode);
    expect(saved.record.maskMode).toBe(maskMode);
    const text = await readFile(saved.sidecar!.path, 'utf8');
    expect(JSON.parse(text)).toMatchObject({ maskMode, inputsIncluded: false });
    expect(text).not.toContain(directory);
  } finally { await workspace.cleanup(); }
});

it.each(['unmasked', 'outpaint'] as const)('derives mask provenance from the %s operation instead of worker claims', async mode => {
  const { maskImage: _mask, ...source } = await fixture(32, 48);
  const request = { ...source, ...(mode === 'outpaint' ? { outpaint: { size: { width: 48, height: 48 }, left: 8, top: 0 } } : {}) };
  const workspace = await ImageWorkspace.create(request);
  try {
    await workspace.prepare(undefined, undefined, 'native');
    const size = workspace.workerRequest.size ?? { width: 32, height: 48 };
    await sharp({ create: { ...size, channels: 3, background: 'blue' } }).png().toFile(workspace.workerRequest.outputPath);
    const saved = await workspace.publish({ model: 'fixture', modelRevision: 'fixture', runtime: { name: 'test', version: '1' }, seed: 1, effectiveParameters: { steps: 1 }, references: [], maskMode: 'composite', image: { path: workspace.workerRequest.outputPath, mimeType: 'image/png', size } });
    if (mode === 'outpaint') expect(saved.record.maskMode).toBe('native');
    else { expect(saved).not.toHaveProperty('maskMode'); expect(saved.record).not.toHaveProperty('maskMode'); }
  } finally { await workspace.cleanup(); }
});
