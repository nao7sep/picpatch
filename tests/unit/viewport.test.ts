import { expect, it } from 'vitest';
import { fitImage, imagePoint, wipeCompatible } from '../../src/shared/viewport.ts';
it('fits a pair together while retaining one shared pixel scale', () => {
  expect(wipeCompatible({ width: 100, height: 200 }, { width: 100, height: 201 })).toBe(false);
});
it('maps pointer positions to source pixels independently of zoom and scrolling', () => {
  expect(imagePoint({ x: 70, y: 40 }, { left: -30, top: -10, width: 200, height: 100 }, { width: 1000, height: 500 })).toEqual({ x: 500, y: 250 });
});
it.each([
  [{ width: 2000, height: 1000 }, { width: 600, height: 500 }, { width: 600, height: 300 }],
  [{ width: 2000, height: 1000 }, { width: 1000, height: 300 }, { width: 600, height: 300 }],
  [{ width: 1000, height: 2000 }, { width: 500, height: 600 }, { width: 300, height: 600 }],
  [{ width: 1000, height: 2000 }, { width: 200, height: 700 }, { width: 200, height: 400 }],
])('fits source and overlay within both stage axes and maps their corners', (image, stage, expected) => {
  const fit = fitImage(image, stage);
  expect(fit).toEqual(expected);
  expect(fit.width).toBeLessThanOrEqual(stage.width);
  expect(fit.height).toBeLessThanOrEqual(stage.height);
  const bounds = { left: (stage.width - fit.width) / 2, top: (stage.height - fit.height) / 2, ...fit };
  expect(imagePoint({ x: bounds.left, y: bounds.top }, bounds, image)).toEqual({ x: 0, y: 0 });
  expect(imagePoint({ x: bounds.left + fit.width, y: bounds.top + fit.height }, bounds, image)).toEqual({ x: image.width, y: image.height });
});
