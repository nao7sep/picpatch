import { expect, it } from 'vitest';
import { exportName } from '../../src/shared/export-name.ts';
it('suggests portable names with authored text and a stable image ordinal', () => {
  expect(exportName('海の風景', 3)).toBe('海の風景 3.png');
  expect(exportName('../bad/name: *', 2)).toBe('..-bad-name- - 2.png');
  expect(exportName('  ... ', 1)).toBe('PicPatch 1.png');
});
