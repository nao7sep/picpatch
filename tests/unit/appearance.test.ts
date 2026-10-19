import { expect, it } from 'vitest';
import { normalizeZoom, nextZoom, windowMinimum } from '../../src/shared/appearance.ts';
it('normalizes disposable zoom and steps without changing canvas dimensions', () => {
  for (const invalid of [undefined, null, '2', NaN, Infinity, 0, 4]) expect(normalizeZoom(invalid)).toBe(1);
  expect(normalizeZoom(1.44)).toBe(1.44); expect(nextZoom(1,'in')).toBe(1.2);
  expect(nextZoom(1.2,'out')).toBe(1); expect(nextZoom(3,'in')).toBe(3); expect(nextZoom(.5,'out')).toBe(.5); expect(nextZoom(2,'reset')).toBe(1);
});
it('scales content floors with native decorations and caps only the native floor', () => {
  const content = {width:1000,height:700}; const frame = {width:0,height:28};
  expect(windowMinimum(content,1.2,frame,{width:1800,height:1200})).toEqual({width:1200,height:868});
  expect(windowMinimum(content,2,frame,{width:1280,height:800})).toEqual({width:1280,height:800});
  expect(content).toEqual({width:1000,height:700});
  expect(windowMinimum(content,2,frame,{width:2560,height:1600})).toEqual({width:2000,height:1428});
});
