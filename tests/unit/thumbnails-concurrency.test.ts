import { readFile } from 'node:fs/promises';
import { beforeEach, expect, it, vi } from 'vitest';
import { Thumbnails } from '../../src/main/core/thumbnails.ts';

const decoding = vi.hoisted(() => [] as { input: Buffer; promise: Promise<Buffer>; resolve: (value: Buffer) => void; reject: (error: Error) => void }[]);
const arrival = vi.hoisted(() => ({ next: Promise.withResolvers<void>() }));
/** Waits until n decodes have started, checking first whether they already have. */
async function started(n: number) { while (decoding.length < n) await arrival.next.promise; }
vi.mock('node:fs/promises', () => ({ readFile: vi.fn(async (path: string) => Buffer.from(path)) }));
vi.mock('sharp', () => ({
  default: vi.fn((input: Buffer) => {
    const held = { input, ...Promise.withResolvers<Buffer>() };
    decoding.push(held); arrival.next.resolve(); arrival.next = Promise.withResolvers<void>();
    const pipeline = { rotate: () => pipeline, resize: () => pipeline, webp: () => pipeline, toBuffer: () => held.promise };
    return pipeline;
  })
}));

beforeEach(() => {
  decoding.length = 0;
  vi.clearAllMocks();
});

it('decodes one path at a time', async () => {
  const thumbnails = new Thumbnails(256);
  const first = thumbnails.get('first'); const second = thumbnails.get('second');
  await started(1);
  decoding[0]!.resolve(Buffer.from('first thumbnail'));
  await first; expect(decoding).toHaveLength(1);
  await started(2);
  decoding[1]!.resolve(Buffer.from('second thumbnail'));
  expect(await second).toEqual(Buffer.from('second thumbnail'));
  expect(readFile).toHaveBeenCalledTimes(2);
});
