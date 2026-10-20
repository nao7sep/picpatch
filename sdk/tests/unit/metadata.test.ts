import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { EditResult } from '../../src/contracts.generated.ts';
import type { EditBackend } from '../../src/execution/backend.ts';
import { ImageClientImpl } from '../../src/execution/session.ts';
import { encodePng, finishImage, pngChunks, sourceMetadata, withoutThumbnail } from '../../src/images/metadata.ts';
import { verifyArtifact, type EditRequest, type GenerateRequest } from '../../src/index.ts';

let directory: string;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'picpatch-metadata-')); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

/** Little-endian EXIF with an orientation in IFD0 and, optionally, a JPEG thumbnail in IFD1. */
function exif(orientation: number, thumbnail?: Buffer): Buffer {
  const ifd1 = 8 + 2 + 12 + 4;
  const data = ifd1 + 2 + 24 + 4;
  const tiff = Buffer.alloc(thumbnail ? data + thumbnail.length : ifd1);
  tiff.write('II', 0, 'latin1'); tiff.writeUInt16LE(42, 2); tiff.writeUInt32LE(8, 4);
  tiff.writeUInt16LE(1, 8); tiff.writeUInt16LE(0x0112, 10); tiff.writeUInt16LE(3, 12); tiff.writeUInt32LE(1, 14); tiff.writeUInt16LE(orientation, 18);
  tiff.writeUInt32LE(thumbnail ? ifd1 : 0, 22);
  if (thumbnail) {
    tiff.writeUInt16LE(2, ifd1);
    tiff.writeUInt16LE(0x0201, ifd1 + 2); tiff.writeUInt16LE(4, ifd1 + 4); tiff.writeUInt32LE(1, ifd1 + 6); tiff.writeUInt32LE(data, ifd1 + 10);
    tiff.writeUInt16LE(0x0202, ifd1 + 14); tiff.writeUInt16LE(4, ifd1 + 16); tiff.writeUInt32LE(1, ifd1 + 18); tiff.writeUInt32LE(thumbnail.length, ifd1 + 22);
    thumbnail.copy(tiff, data);
  }
  return tiff;
}
/** A 3 × 2 image whose six pixels all differ, so any wrong turn or mirror changes the bytes. */
const pixels = Buffer.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 0, 0, 255, 255, 255, 0, 255]);
const png = (raw: Buffer, width: number, height: number) => sharp(raw, { raw: { width, height, channels: 3 } }).png().toBuffer();
const withChunks = (bytes: Buffer, extra: { type: string; data: Buffer }[]) => { const [head, ...rest] = pngChunks(bytes); return encodePng([head!, ...extra, ...rest]); };
const ancillary = (bytes: Buffer) => pngChunks(bytes).filter(chunk => !['IHDR', 'IDAT', 'IEND'].includes(chunk.type));

it.each([1, 2, 3, 4, 5, 6, 7, 8])('turns upright pixels back to stored orientation %i', async orientation => {
  const source = join(directory, 'source.png');
  await writeFile(source, withChunks(await png(pixels, 3, 2), [{ type: 'eXIf', data: exif(orientation) }]));
  expect((await sharp(source).metadata()).orientation).toBe(orientation);
  const upright = join(directory, 'upright.png');
  await sharp(source).autoOrient().png().toFile(upright);
  const target = join(directory, 'target.png');
  await finishImage(upright, target, directory, await sourceMetadata(source));
  expect(await sharp(target).raw().toBuffer()).toEqual(pixels);
  expect((await sharp(target).metadata()).orientation).toBe(orientation);
});

it('drops only the EXIF preview thumbnail', () => {
  const original = exif(6, Buffer.from('THUMBNAIL BEFORE THE EDIT'));
  const kept = withoutThumbnail(Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), original]));
  expect(kept.length).toBe(original.length);
  expect(kept.toString('latin1')).not.toContain('THUMBNAIL');
  expect(kept.readUInt32LE(22)).toBe(0);
  expect(kept.subarray(0, 22)).toEqual(original.subarray(0, 22));
  expect(withoutThumbnail(exif(3))).toEqual(exif(3));
});

function backend(generate: EditBackend['generate'], edit: EditBackend['edit']): EditBackend {
  return { generate, edit, validate: async () => ({ model: 'test', textToImage: true, instructionEditing: true, referenceRoles: [], maskMode: 'none' }), dispose: async () => {} };
}
const result = (path: string, width: number, height: number): EditResult => ({ image: { path, mimeType: 'image/png', size: { width, height } }, model: 'test', effectiveParameters: {}, modelRevision: 'rev', runtime: { name: 'test', version: '1' }, seed: 1, references: [] });

it('publishes a generated image with no metadata at all', async () => {
  const client = new ImageClientImpl(backend(async (request: GenerateRequest) => {
    // The engine's own file may carry metadata (here a physical size and a comment); none reaches the output.
    await writeFile(request.outputPath, withChunks(await png(pixels, 3, 2), [{ type: 'tEXt', data: Buffer.from('Comment\0prompt text', 'latin1') }]));
    return result(request.outputPath, 3, 2);
  }, async () => { throw new Error('unused'); }));
  try {
    const saved = await client.generate({ model: 'test', prompt: 'Draw', outputPath: join(directory, 'out.png') });
    if (saved.status === 'refused') throw new Error(saved.code);
    expect(ancillary(await readFile(saved.image.path))).toEqual([]);
  } finally { await client.dispose(); }
});

it('keeps all of an edit source’s metadata, in its orientation and colour profile, without its preview', async () => {
  const profiled = await sharp(await png(pixels, 3, 2)).withIccProfile('p3').png().toBuffer();
  const xmp = Buffer.concat([Buffer.from('XML:com.adobe.xmp\0\0\0\0\0', 'latin1'), Buffer.from('<x:xmpmeta xmlns:x="adobe:ns:meta/">rights</x:xmpmeta>')]);
  const carried = [{ type: 'eXIf', data: exif(6, Buffer.from('THUMBNAIL')) }, { type: 'iTXt', data: xmp }, { type: 'tEXt', data: Buffer.from('Author\0Someone', 'latin1') }];
  const source = join(directory, 'source.png');
  await writeFile(source, withChunks(profiled, carried));
  const before = ancillary(await readFile(source));
  const client = new ImageClientImpl(backend(async () => { throw new Error('unused'); }, async (request: EditRequest) => {
    // The engine sees upright sRGB pixels (2 × 3 for orientation 6) and returns the same size.
    const input = await sharp(request.sourceImage!).metadata();
    expect([input.width, input.height, input.orientation ?? 1]).toEqual([2, 3, 1]);
    await sharp(request.sourceImage!).png().toFile(request.outputPath);
    return result(request.outputPath, 2, 3);
  }));
  try {
    const saved = await client.edit({ model: 'test', instruction: 'Edit', sourceImage: source, outputPath: join(directory, 'out.png') });
    if (saved.status === 'refused') throw new Error(saved.code);
    const bytes = await readFile(saved.image.path);
    const after = ancillary(bytes);
    expect(after.map(chunk => chunk.type)).toEqual(before.map(chunk => chunk.type));
    for (const [index, chunk] of after.entries()) {
      if (chunk.type === 'eXIf') expect(chunk.data).toEqual(withoutThumbnail(before[index]!.data));
      else expect(chunk.data).toEqual(before[index]!.data);
    }
    expect(bytes.toString('latin1')).not.toContain('THUMBNAIL');
    const metadata = await sharp(bytes).metadata();
    // Stored as the source is stored, displayed upright; the record states the displayed size.
    expect([metadata.width, metadata.height, metadata.orientation]).toEqual([3, 2, 6]);
    expect(saved.record.image.size).toEqual({ width: 2, height: 3 });
    expect(await verifyArtifact(saved.image.path, saved.record)).toMatchObject({ status: 'completed' });
  } finally { await client.dispose(); }
});

it('carries a JPEG source’s EXIF, colour profile and density into the PNG', async () => {
  const source = join(directory, 'source.jpg');
  await sharp(pixels, { raw: { width: 3, height: 2, channels: 3 } }).withIccProfile('p3').withMetadata({ orientation: 8, density: 300 }).jpeg({ quality: 100 }).toFile(source);
  const input = await sharp(source).metadata();
  const client = new ImageClientImpl(backend(async () => { throw new Error('unused'); }, async (request: EditRequest) => {
    await sharp(request.sourceImage!).png().toFile(request.outputPath);
    return result(request.outputPath, 2, 3);
  }));
  try {
    const saved = await client.edit({ model: 'test', instruction: 'Edit', sourceImage: source, outputPath: join(directory, 'out.png') });
    if (saved.status === 'refused') throw new Error(saved.code);
    const output = await sharp(saved.image.path).metadata();
    expect([output.width, output.height, output.orientation, output.density]).toEqual([3, 2, 8, 300]);
    expect(output.icc).toEqual(input.icc);
    expect(output.exif).toEqual(withoutThumbnail(input.exif!));
  } finally { await client.dispose(); }
});
