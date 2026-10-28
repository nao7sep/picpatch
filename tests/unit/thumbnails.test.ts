import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { Thumbnails } from '../../src/main/core/thumbnails.ts';
let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'picpatch-thumbs-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
it('resizes the shortest edge for cropped previews', async () => {
  const path = join(root, 'wide.png'); await sharp({ create: { width: 2000, height: 1000, channels: 3, background: '#808080' } }).png().toFile(path);
  expect(await sharp(await new Thumbnails(256).get(path)).metadata()).toMatchObject({ format: 'webp', width: 512, height: 256 });
});
