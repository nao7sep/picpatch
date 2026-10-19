import { expect, it } from 'vitest';
import { fitScale, imagePoint, wipeCompatible } from '../../src/shared/viewport.ts';
it('fits a pair together while retaining one shared pixel scale', () => {
  expect(fitScale({ width: 1044, height: 632 }, { width: 1000, height: 600 }, { width: 1000, height: 500 })).toBeCloseTo(1012 / 2012);
  expect(wipeCompatible({ width: 100, height: 200 }, { width: 100, height: 201 })).toBe(false);
});
it('maps pointer positions to source pixels independently of zoom and scrolling', () => {
  expect(imagePoint({ x: 70, y: 40 }, { left: -30, top: -10, width: 200, height: 100 }, { width: 1000, height: 500 })).toEqual({ x: 500, y: 250 });
});
