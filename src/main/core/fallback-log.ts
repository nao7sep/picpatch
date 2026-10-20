import { join } from 'node:path';
/**
 * The launch's fallback log, for records the database could not take: named to the second in UTC, since
 * the single-instance lock allows one launch at a time and a launch appends to its own file.
 */
export function fallbackLog(root: string, session: string): string {
  const stamp = session.slice(0, 19).replaceAll('-', '').replaceAll(':', '').replace('T', '-');
  return join(root, 'logs', `${stamp}-utc.log`);
}
