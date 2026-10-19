import { expect, it } from 'vitest';
import { exportName } from '../../src/shared/export-name.ts';
it('suggests portable names with authored text and a stable image ordinal', () => {
  expect(exportName('海の風景', 3)).toBe('海の風景 3.png');
  expect(exportName('../bad/name: *', 2)).toBe('..-bad-name- - 2.png');
  expect(exportName('  ... ', 1)).toBe('PicPatch 1.png');
});
it('bounds multibyte names by filesystem bytes without splitting Unicode characters', () => {
  const result = exportName('風景🎨'.repeat(100), 12);
  expect(new TextEncoder().encode(result).length).toBeLessThanOrEqual(255);
  expect(result.isWellFormed()).toBe(true); expect(result).toMatch(/ 12\.png$/);
});
