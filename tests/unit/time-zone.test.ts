import { expect, it } from 'vitest';
import { displayTimeZone, systemTimeZone, validTimeZone } from '../../src/shared/time-zone.ts';
import { relativeTime } from '../../src/renderer/src/time.ts';
it('shows times in the chosen zone, or the computer\'s zone for System', () => {
  expect(validTimeZone('Asia/Tokyo')).toBe(true); expect(validTimeZone('Mars/Olympus')).toBe(false); expect(validTimeZone('')).toBe(false);
  expect(displayTimeZone('Asia/Tokyo')).toBe('Asia/Tokyo');
  expect(displayTimeZone(undefined)).toBe(systemTimeZone()); expect(displayTimeZone('Mars/Olympus')).toBe(systemTimeZone());
  expect(systemTimeZone()).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
});
it('dates older sessions in the display zone', () => {
  const now = Date.parse('2026-10-20T12:00:00.000Z');
  // 23:30 UTC on 1 October is already 2 October in Tokyo.
  expect(relativeTime('2026-10-01T23:30:00.000Z', 'UTC', now)).toBe('Oct 1, 2026');
  expect(relativeTime('2026-10-01T23:30:00.000Z', 'Asia/Tokyo', now)).toBe('Oct 2, 2026');
});
