import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { inputGeometry } from '../../src/images/geometry.ts';
import { prepareImage } from '../../src/images/validation.ts';
import { ImageWorkspace } from '../../src/images/output.ts';
let directory: string;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'picpatch-geometry-')); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

it.each([
  [16, 16, 16, 16, 0, 0], [1024, 1024, 1024, 1024, 0, 0],
  [2048, 1024, 1440, 720, 4, 2], [33, 47, 32, 32, 0, 7], [4096, 64, 4096, 64, 0, 0],
])('plans model geometry for %s by %s without coupling to output size', (width, height, w, h, left, top) => {
  expect(inputGeometry(width, height, 1, 'klein-reference')).toMatchObject({ preparedSize: { width: w, height: h }, crop: { left, top } });
});
it.each([[15, 32], [100000, 16]])('rejects unusable narrow geometry %s by %s', (width, height) => {
  expect(() => inputGeometry(width, height, 1, 'klein-reference')).toThrow(expect.objectContaining({ code: 'INVALID_IMAGE' }));
});
it('crops residual edges with the documented center bias and preserves interior pixels', async () => {
  const source = join(directory, 'grid.png');
  const pixels = Buffer.alloc(35 * 51 * 3);
  for (let y = 0; y < 51; y++) for (let x = 0; x < 35; x++) pixels.set([x, y, 100], (y * 35 + x) * 3);
  await sharp(pixels, { raw: { width: 35, height: 51, channels: 3 } }).png().toFile(source);
  const original = await readFile(source);
  const result = await prepareImage(source, join(directory, 'in.tmp'), join(directory, 'ready.png'), false, undefined, 'klein-reference');
  expect(result.geometry).toMatchObject({ originalSize: { width: 35, height: 51 }, preparedSize: { width: 32, height: 48 }, crop: { left: 1, top: 1 } });
  const output = await sharp(result.path).raw().toBuffer();
  expect([...output.subarray(0, 3)]).toEqual([1, 1, 100]);
  expect([...output.subarray(-3)]).toEqual([32, 48, 100]);
  expect(await readFile(source)).toEqual(original);
});
it('orients before cropping and records authored and prepared dimensions', async () => {
  const source = join(directory, 'oriented.png');
  await sharp({ create: { width: 35, height: 51, channels: 3, background: 'red' } }).png().withMetadata({ orientation: 6 }).toFile(source);
  const result = await prepareImage(source, join(directory, 'in.tmp'), join(directory, 'ready.png'), false, undefined, 'klein-reference');
  expect(result.geometry).toEqual({ originalSize: { width: 35, height: 51 }, orientedSize: { width: 51, height: 35 }, scaledSize: { width: 51, height: 35 }, preparedSize: { width: 48, height: 32 }, crop: { left: 1, top: 1 } });
  expect((await sharp(result.path).metadata()).orientation).toBeUndefined();
});
it('downscales large inputs once and retains uniform colors at the model resolution', async () => {
  const source = join(directory, 'large.png');
  await sharp({ create: { width: 2048, height: 1024, channels: 3, background: '#804020' } }).png().toFile(source);
  const result = await prepareImage(source, join(directory, 'in.tmp'), join(directory, 'ready.png'), false, undefined, 'klein-reference');
  expect(result.geometry.scaledSize).toEqual({ width: 1448, height: 724 });
  expect(await sharp(result.path).metadata()).toMatchObject({ width: 1440, height: 720 });
  const stats = await sharp(result.path).stats();
  expect(stats.channels.map(channel => Math.round(channel.mean))).toEqual([128, 64, 32]);
  expect(inputGeometry(1440, 720, 1, 'klein-reference').preparedSize).toEqual({ width: 1440, height: 720 });
});
it('keeps independent mixed input sizes and reports caller paths after publication', async () => {
  const source = join(directory, 'source.png'); const reference = join(directory, 'reference.png');
  await sharp({ create: { width: 35, height: 51, channels: 3, background: 'red' } }).png().toFile(source);
  await sharp({ create: { width: 64, height: 33, channels: 3, background: 'blue' } }).png().toFile(reference);
  const work = await ImageWorkspace.create({ model: 'fixture', instruction: 'Combine colors.', sourceImage: source,
    references: [{ id: 'palette', role: 'style', images: [reference] }], size: { width: 16, height: 16 }, outputPath: join(directory, 'out.png') });
  try {
    await work.prepare(undefined, 'klein-reference');
    expect(await sharp(work.workerRequest.sourceImage!).metadata()).toMatchObject({ width: 32, height: 48 });
    expect(await sharp(work.workerRequest.references![0].images[0]).metadata()).toMatchObject({ width: 64, height: 32 });
    await sharp({ create: { width: 16, height: 16, channels: 3, background: 'green' } }).png().toFile(work.workerRequest.outputPath);
    const saved = await work.publish({ model: 'fixture', effectiveParameters: {}, modelRevision: 'test', runtime: { name: 'test', version: '1' }, seed: 0, references: [],
      image: { path: work.workerRequest.outputPath, mimeType: 'image/png', size: { width: 16, height: 16 } } });
    expect(saved.inputGeometry?.map(image => [image.path, image.preparedSize])).toEqual([[source, { width: 32, height: 48 }], [reference, { width: 64, height: 32 }]]);
    expect(JSON.stringify(saved.inputGeometry)).not.toContain('.picpatch-');
  } finally { await work.cleanup(); }
});
it('keeps mask edges unchanged without a geometry policy and refuses unsupported mask transforms', async () => {
  const mask = join(directory, 'mask.png');
  const pixels = Buffer.alloc(32 * 32); pixels.fill(255, 32 * 16);
  await sharp(pixels, { raw: { width: 32, height: 32, channels: 1 } }).toColourspace('b-w').png().toFile(mask);
  const prepared = await prepareImage(mask, join(directory, 'mask.tmp'), join(directory, 'prepared.png'), true);
  expect(await sharp(prepared.path).toColourspace('b-w').raw().toBuffer()).toEqual(pixels);
  await expect(prepareImage(mask, join(directory, 'other.tmp'), join(directory, 'other.png'), true, undefined, 'klein-reference')).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
});

it('does not accept truncated image content when a crop is required', async () => {
  const source = join(directory, 'truncated.png');
  const bytes = await sharp({ create: { width: 35, height: 51, channels: 3, background: 'blue' } }).png().toBuffer();
  await writeFile(source, bytes.subarray(0, bytes.length - 20));
  await expect(prepareImage(source, join(directory, 'in.tmp'), join(directory, 'ready.png'), false, undefined, 'klein-reference')).rejects.toMatchObject({ code: 'INVALID_IMAGE' });
});

it('keeps generated oriented geometry contained, aligned and stable on re-preparation', () => {
  for (let i = 1; i <= 120; i++) {
    const width = 32 + (i * 137) % 4000; const height = 32 + (i * 211) % 3000;
    for (const orientation of [1, 3, 6, 8]) {
      const geometry = inputGeometry(width, height, orientation, 'klein-reference');
      expect(geometry.preparedSize.width % 16).toBe(0); expect(geometry.preparedSize.height % 16).toBe(0);
      expect(geometry.crop.left + geometry.preparedSize.width).toBeLessThanOrEqual(geometry.scaledSize.width);
      expect(geometry.crop.top + geometry.preparedSize.height).toBeLessThanOrEqual(geometry.scaledSize.height);
      expect(inputGeometry(geometry.preparedSize.width, geometry.preparedSize.height, 1, 'klein-reference').preparedSize).toEqual(geometry.preparedSize);
    }
  }
});
