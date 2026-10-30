import { expect, it } from 'vitest';
import { extend, MaskHistory, pixelRect, type Rect, type Region } from '../../src/renderer/src/modals/mask-history.ts';

/** A one-channel layer standing in for the canvas. */
function layer(width: number, height: number) {
  const values = new Uint8Array(width * height);
  const read = (rect: Rect) => { const out = new Uint8Array(rect.width * rect.height); for (let y = 0; y < rect.height; y++) out.set(values.subarray((rect.y + y) * width + rect.x, (rect.y + y) * width + rect.x + rect.width), y * rect.width); return out; };
  const write = ({ rect, pixels }: Region<Uint8Array>) => { for (let y = 0; y < rect.height; y++) values.set(pixels.subarray(y * rect.width, (y + 1) * rect.width), (rect.y + y) * width + rect.x); };
  const paint = (rect: Rect, value: number) => { const before = read(rect); write({ rect, pixels: new Uint8Array(rect.width * rect.height).fill(value) }); return { rect, pixels: before }; };
  return { values, surface: { read, write }, paint };
}

it('bounds a stroke by its dabs, with a pixel of antialiasing, inside the image', () => {
  const bounds = extend(extend(undefined, 10, 10, 3), 20.5, 12, 3);
  expect(bounds).toEqual({ x: 7, y: 7, width: 16.5, height: 8 });
  expect(pixelRect(bounds, { width: 100, height: 100 })).toEqual({ x: 6, y: 6, width: 19, height: 10 });
  expect(pixelRect(extend(undefined, 1, 1, 4), { width: 4, height: 4 })).toEqual({ x: 0, y: 0, width: 4, height: 4 });
  expect(pixelRect(extend(undefined, -20, -20, 4), { width: 4, height: 4 })).toBeUndefined();
});

it('undoes and redoes strokes from the regions they changed, any number of steps deep', () => {
  const { values, surface, paint } = layer(64, 64);
  const history = new MaskHistory(surface);
  const states: string[] = [values.join()];
  for (let i = 0; i < 200; i++) { history.record(paint({ x: i % 60, y: (i * 7) % 60, width: 4, height: 4 }, i % 255 + 1)); states.push(values.join()); }
  for (let i = 199; i >= 0; i--) { expect(history.step('undo')).toBe(true); expect(values.join()).toBe(states[i]); }
  expect(history.canUndo).toBe(false); expect(history.step('undo')).toBe(false);
  for (let i = 1; i <= 200; i++) { history.step('redo'); expect(values.join()).toBe(states[i]); }
  history.step('undo'); history.record(paint({ x: 0, y: 0, width: 64, height: 64 }, 0));
  expect(history.canRedo).toBe(false);
  history.step('undo'); expect(values.join()).toBe(states[199]);
});
