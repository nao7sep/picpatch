import { expect, it } from 'vitest';
import { imagePoint, wipeCompatible } from '../../src/shared/viewport.ts';
it('fits a pair together while retaining one shared pixel scale', () => {
  expect(wipeCompatible({ width: 100, height: 200 }, { width: 100, height: 201 })).toBe(false);
});
it('maps pointer positions to source pixels independently of zoom and scrolling', () => {
  expect(imagePoint({ x: 70, y: 40 }, { left: -30, top: -10, width: 200, height: 100 }, { width: 1000, height: 500 })).toEqual({ x: 500, y: 250 });
});
