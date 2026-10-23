import { readFile } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import sharp from 'sharp';
import { beforeEach, expect, it, vi } from 'vitest';
import { Thumbnails } from '../../src/main/core/thumbnails.ts';

const decoding = vi.hoisted(() => [] as { input: Buffer; promise: Promise<Buffer>; resolve: (value: Buffer) => void; reject: (error: Error) => void }[]);
vi.mock('node:fs/promises', () => ({ readFile: vi.fn(async (path: string) => Buffer.from(path)) }));
vi.mock('node:os', () => ({ availableParallelism: vi.fn(() => 8) }));
vi.mock('sharp', () => ({
  default: Object.assign(vi.fn((input: Buffer) => {
    const held = { input, ...Promise.withResolvers<Buffer>() };
    decoding.push(held);
    const pipeline = { rotate: () => pipeline, resize: () => pipeline, webp: () => pipeline, toBuffer: () => held.promise };
    return pipeline;
  }), { concurrency: vi.fn(() => 2) })
}));

beforeEach(() => {
  decoding.length = 0;
  vi.clearAllMocks();
  vi.mocked(availableParallelism).mockReturnValue(8);
  vi.mocked(sharp.concurrency).mockReturnValue(2);
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

it('admits reads with decodes according to host capacity and each Sharp worker team', async () => {
  vi.mocked(availableParallelism).mockReturnValue(6);
  const thumbnails = new Thumbnails(256, 1);
  const requests = Array.from({ length: 5 }, (_, index) => thumbnails.get(String(index)));
  await expect.poll(() => decoding.length).toBe(3);
  expect(readFile).toHaveBeenCalledTimes(3);
  expect(thumbnails.get('4')).toBe(requests[4]);
  expect(decoding.map(item => item.input.toString())).toEqual(['0', '1', '2']);
  for (let index = 0; index < requests.length; index++) {
    await expect.poll(() => decoding.length).toBe(Math.min(3 + index, 5));
    decoding[index]!.resolve(Buffer.from(`thumbnail ${index}`));
    await requests[index];
  }
  expect(readFile).toHaveBeenCalledTimes(5);
  expect(decoding.map(item => item.input.toString())).toEqual(['0', '1', '2', '3', '4']);
});

it('keeps one decode slot on a host smaller than a Sharp worker team and releases failed work', async () => {
  vi.mocked(availableParallelism).mockReturnValue(1);
  const thumbnails = new Thumbnails(256);
  const failed = thumbnails.get('broken');
  const rejected = expect(failed).rejects.toThrow('decode failed');
  const queued = thumbnails.get('queued');
  await expect.poll(() => decoding.length).toBe(1);
  expect(readFile).toHaveBeenCalledTimes(1);
  decoding[0]!.reject(new Error('decode failed'));
  await rejected;
  await expect.poll(() => decoding.length).toBe(2);
  const retry = thumbnails.get('broken');
  expect(retry).not.toBe(failed);
  expect(readFile).toHaveBeenCalledTimes(2);
  decoding[1]!.resolve(Buffer.from('queued thumbnail'));
  await queued;
  await expect.poll(() => decoding.length).toBe(3);
  decoding[2]!.resolve(Buffer.from('repaired thumbnail'));
  expect((await retry).toString()).toBe('repaired thumbnail');
  expect(readFile).toHaveBeenCalledTimes(3);
});

it('releases admission after a read failure and retries the path instead of caching the failure', async () => {
  vi.mocked(availableParallelism).mockReturnValue(1);
  vi.mocked(readFile).mockRejectedValueOnce(new Error('read failed'));
  const thumbnails = new Thumbnails(256);
  const failed = thumbnails.get('unreadable');
  const rejected = expect(failed).rejects.toThrow('read failed');
  const queued = thumbnails.get('queued');
  await rejected;
  await expect.poll(() => decoding.length).toBe(1);
  expect(decoding[0]!.input.toString()).toBe('queued');
  const retry = thumbnails.get('unreadable');
  decoding[0]!.resolve(Buffer.from('queued thumbnail'));
  await queued;
  await expect.poll(() => decoding.length).toBe(2);
  expect(decoding[1]!.input.toString()).toBe('unreadable');
  decoding[1]!.resolve(Buffer.from('readable thumbnail'));
  await retry;
});
