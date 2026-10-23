import sharp from 'sharp';
import { afterEach, expect, it, vi } from 'vitest';
import { MaskEditor } from '../../src/renderer/src/mask/editor.ts';
import { maskToOverlay, overlayToMask } from '../../src/renderer/src/mask/pixels.ts';

/** Canvas boundary double: pixel/history/encoding orchestration uses the actual
 * editor; Sharp verifies the emitted PNG independently of browser presentation. */
class PixelCanvas {
  pixels: Uint8ClampedArray;
  constructor(readonly width: number, readonly height: number) { this.pixels = new Uint8ClampedArray(width * height * 4); }
  getContext() {
    return {
      getImageData: () => ({ data: this.pixels.slice(), width: this.width, height: this.height }),
      putImageData: (image: { data: Uint8ClampedArray }) => { this.pixels.set(image.data); },
      drawImage: (image: PixelCanvas) => { this.pixels.set(image.pixels); },
      clearRect: () => this.pixels.fill(0),
    };
  }
  async convertToBlob() {
    const png = await sharp(Buffer.from(this.pixels), { raw: { width: this.width, height: this.height, channels: 4 } }).png().toBuffer();
    return new Blob([new Uint8Array(png)]);
  }
}
afterEach(() => vi.unstubAllGlobals());

it('round-trips every grayscale level including antialiased edges with opaque output', () => {
  const pixels = new Uint8ClampedArray(256 * 4);
  for (let i = 0; i < 256; ++i) pixels.set([i, i, i, 255], i * 4);
  const original = pixels.slice();
  maskToOverlay(pixels);
  for (let i = 0; i < 256; ++i) expect([...pixels.slice(i * 4, i * 4 + 4)]).toEqual([242, 166, 90, i]);
  expect(overlayToMask(pixels)).toBe(true);
  expect(pixels).toEqual(original);
});

it('preserves non-square source resolution, undo/redo pixels, and transparent-mask removal', async () => {
  vi.stubGlobal('OffscreenCanvas', PixelCanvas);
  const width = 131, height = 73;
  const canvas = new PixelCanvas(width, height), mask = new PixelCanvas(width, height);
  const close = vi.fn();
  for (let i = 0; i < width * height; ++i) mask.pixels.set([i % 256, i % 256, i % 256, 255], i * 4);
  const original = mask.pixels.slice();
  const editor = new MaskEditor();
  await editor.run({ kind: 'init', canvas: canvas as unknown as OffscreenCanvas, mask: Object.assign(mask, { close }) as unknown as ImageBitmap });
  expect(close).toHaveBeenCalledOnce();
  const overlay = canvas.pixels.slice();
  expect(await editor.run({ kind: 'clear' })).toEqual({ undo: true, redo: false });
  expect((await editor.run({ kind: 'encode' })).bytes).toBeNull();
  expect(await editor.run({ kind: 'undo' })).toEqual({ undo: false, redo: true });
  expect(canvas.pixels).toEqual(overlay);
  const output = (await editor.run({ kind: 'encode' })).bytes!;
  const decoded = await sharp(output).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  expect([decoded.info.width, decoded.info.height]).toEqual([width, height]);
  expect(new Uint8ClampedArray(decoded.data)).toEqual(original);
  expect(await editor.run({ kind: 'redo' })).toEqual({ undo: true, redo: false });
  expect(canvas.pixels.every(value => value === 0)).toBe(true);
  await editor.run({ kind: 'undo' });
  await editor.run({ kind: 'begin' });
  expect((await editor.run({ kind: 'end' })).redo).toBe(false);
});
