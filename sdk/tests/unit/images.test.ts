import { mkdtemp, rm, writeFile, readFile, symlink, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { prepareImage } from '../../src/images/validation.ts';
let directory: string;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'picpatch-images-')); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
function prepare(source: string, mask = false, prefix = 'prepared') { return prepareImage(source, join(directory, `${prefix}.tmp`), join(directory, `${prefix}.png`), mask); }
async function image(name = 'source.png') {
  const path = join(directory, name);
  await sharp({ create: { width: 4, height: 3, channels: 3, background: '#203040' } }).png().toFile(path);
  return path;
}
describe('image content validation', () => {
  it('validates content rather than filename and leaves original bytes unchanged', async () => {
    const source = await image('misleading.txt'); const original = await readFile(source);
    const result = await prepare(source); expect(result).toMatchObject({ width: 4, height: 3 });
    expect(await readFile(source)).toEqual(original);
    expect((await sharp(result.path).metadata()).format).toBe('png');
  });
  it('normalizes EXIF orientation and removes metadata', async () => {
    const source = join(directory, 'oriented.jpg');
    await sharp({ create: { width: 4, height: 3, channels: 3, background: '#203040' } }).jpeg().withMetadata({ orientation: 6 }).toFile(source);
    const result = await prepare(source); expect(result).toMatchObject({ width: 3, height: 4 });
    expect((await sharp(result.path).metadata()).orientation).toBeUndefined();
  });
  it('recognizes symlinks and hardlinks as the same input identity', async () => {
    const source = await image(); const alias = join(directory, 'alias'); const hard = join(directory, 'hard');
    await symlink(source, alias); await link(source, hard);
    const identities = [];
    for (const [index, path] of [source, alias, hard].entries()) identities.push((await prepare(path, false, `p${index}`)).identity);
    expect(new Set(identities).size).toBe(1);
  });
  it.each(['missing', 'text', 'truncated', 'directory', 'svg'])('rejects %s input', async kind => {
    let source = join(directory, 'invalid');
    if (kind === 'text') await writeFile(source, 'not an image');
    if (kind === 'directory') source = directory;
    if (kind === 'svg') await writeFile(source, '<svg xmlns="http://www.w3.org/2000/svg" width="3" height="3"/>');
    if (kind === 'truncated') { const valid = await image(); const bytes = await readFile(valid); await writeFile(source, bytes.subarray(0, bytes.length - 20)); }
    await expect(prepare(source)).rejects.toMatchObject({ code: kind === 'missing' ? 'FILE_NOT_FOUND' : 'INVALID_IMAGE' });
  });
  it('requires an opaque grayscale PNG mask', async () => {
    const source = await image(); await expect(prepare(source, true)).rejects.toMatchObject({ code: 'INVALID_MASK' });
    const mask = join(directory, 'mask.png');
    await sharp(Buffer.alloc(12, 128), { raw: { width: 4, height: 3, channels: 1 } }).toColourspace('b-w').png().toFile(mask);
    expect(await prepare(mask, true, 'gray')).toMatchObject({ width: 4, height: 3 });
  });
  it('does not open files for pre-cancelled work', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(prepareImage('/missing', join(directory, 's'), join(directory, 'o'), false, controller.signal)).rejects.toMatchObject({ code: 'CANCELLED' });
  });
});

it('rejects an animated WebP rather than silently using the first frame', async () => {
  const source = join(directory, 'animated.webp');
  const pixels = Buffer.concat([Buffer.alloc(12, 0), Buffer.alloc(12, 255)]);
  await sharp(pixels, { raw: { width: 2, height: 4, channels: 3, pageHeight: 2 } }).webp({ loop: 0, delay: [100, 100] }).toFile(source);
  expect((await sharp(source).metadata()).pages).toBe(2);
  await expect(prepare(source)).rejects.toMatchObject({ code: 'INVALID_IMAGE' });
});
describe('image metadata inspection', () => {
  it('reports a file it cannot read as an I/O failure and unreadable content as an invalid image', async () => {
    const { inspectImageMetadata } = await import('../../src/images/fingerprint.ts');
    await expect(inspectImageMetadata(join(directory, 'gone.png'), undefined, true)).rejects.toMatchObject({ code: 'FILE_NOT_FOUND', kind: 'unavailable' });
    const garbage = join(directory, 'garbage.png'); await writeFile(garbage, 'not an image');
    await expect(inspectImageMetadata(garbage, undefined, true)).rejects.toMatchObject({ code: 'INVALID_IMAGE' });
    expect(await inspectImageMetadata(await image(), undefined, true)).toMatchObject({ format: 'png', width: 4, height: 3 });
  });
});
