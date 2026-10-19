// Relative times for identifying text (the rail), in the interface language's format.
import { activeLocale } from '../../shared/i18n/index.ts';

const MINUTE = 60_000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;

export function relativeTime(iso: string, now = Date.now()): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return '';
  const format = activeLocale().format;
  const elapsed = now - then;
  const relative = new Intl.RelativeTimeFormat(format, { numeric: 'auto', style: 'long' });
  if (elapsed < MINUTE) return relative.format(0, 'second');
  if (elapsed < HOUR) return relative.format(-Math.floor(elapsed / MINUTE), 'minute');
  if (elapsed < DAY) return relative.format(-Math.floor(elapsed / HOUR), 'hour');
  if (elapsed < 7 * DAY) return relative.format(-Math.floor(elapsed / DAY), 'day');
  return new Intl.DateTimeFormat(format, { dateStyle: 'medium' }).format(then);
}

/** Elapsed seconds as m:ss, for a running result. */
export function elapsed(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
