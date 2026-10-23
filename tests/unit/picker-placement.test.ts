// @vitest-environment happy-dom
import { expect, it } from 'vitest';
import { placePopover } from '../../src/renderer/src/components/Popover.tsx';

it('keeps size and model pickers within supported viewport edges and constrains tall panels', () => {
  for (const placement of ['above-start', 'below-end'] as const) {
    for (const left of [8, 650]) {
      const position = placePopover({ left, right: left + 90, top: 310, bottom: 340 }, { width: 420, height: 700 }, 760, 384, placement);
      expect(position.left).toBeGreaterThanOrEqual(8);
      expect(position.left + Math.min(420, position.maxWidth)).toBeLessThanOrEqual(752);
      expect(position.top).toBeGreaterThanOrEqual(8);
      expect(position.top + Math.min(700, position.maxHeight)).toBeLessThanOrEqual(376);
    }
  }
});
