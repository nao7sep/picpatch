import { readFile } from 'node:fs/promises';
import { beforeEach, expect, it, vi } from 'vitest';
import { Thumbnails } from '../../src/main/core/thumbnails.ts';

const decoding = vi.hoisted(() => [] as { input: Buffer; promise: Promise<Buffer>; resolve: (value: Buffer) => void; reject: (error: Error) => void }[]);
vi.mock('node:fs/promises', () => ({ readFile: vi.fn(async (path: string) => Buffer.from(path)) }));
vi.mock('sharp', () => ({
  default: vi.fn((input: Buffer) => {
    const held = { input, ...Promise.withResolvers<Buffer>() };
    decoding.push(held);
    const pipeline = { rotate: () => pipeline, resize: () => pipeline, webp: () => pipeline, toBuffer: () => held.promise };
    return pipeline;
  })
}));

beforeEach(() => {
  decoding.length = 0;
  vi.clearAllMocks();
});

it('keeps active requests deduplicated when completed thumbnails evict each other', async () => {
  const thumbnails = new Thumbnails(256, 1);
  const first = thumbnails.get('first');
  const second = thumbnails.get('second');
  const third = thumbnails.get('third');
  await expect.poll(() => decoding.length).toBe(3);
  decoding[1]!.resolve(Buffer.from('second thumbnail'));
  await second;
  decoding[2]!.resolve(Buffer.from('third thumbnail'));
  await third;
  expect(thumbnails.get('first')).toBe(first);
  expect(readFile).toHaveBeenCalledTimes(3);
  decoding[0]!.resolve(Buffer.from('first thumbnail'));
  const result = await first;
  expect(await thumbnails.get('first')).toBe(result);
  expect(readFile).toHaveBeenCalledTimes(3);
});
