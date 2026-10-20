import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { Thumbnails } from '../../src/main/core/thumbnails.ts';
let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'picpatch-thumbs-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
it('resizes the shortest edge for cropped previews, reuses results and evicts the oldest path', async () => {
  const paths = await Promise.all([0, 1].map(async index => { const path = join(root, `${index}.png`); await sharp({ create: { width: 2000, height: 1000, channels: 3, background: '#808080' } }).png().toFile(path); return path; }));
  const thumbnails = new Thumbnails(256, 1);
  const first = thumbnails.get(paths[0]!); expect(thumbnails.get(paths[0]!)).toBe(first);
  expect(await sharp(await first).metadata()).toMatchObject({ format: 'webp', width: 512, height: 256 });
  await thumbnails.get(paths[1]!); const again = thumbnails.get(paths[0]!); expect(again).not.toBe(first); await again;
});
