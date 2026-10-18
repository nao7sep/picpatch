import { createWriteStream } from 'node:fs';
import type { SdkEvent } from './diagnostics.ts';

export interface LogOutcome { path: string; status: 'written' | 'failed'; }
export interface LogResult { log?: LogOutcome }
export type Logged<T> = T & LogResult;

/** Optional diagnostics have one bounded buffer and never delay primary work. No fallback sink. */
export function eventLog(path: string) {
  const stream = createWriteStream(path, { flags: 'wx', mode: 0o600, highWaterMark: 64 * 1024 });
  let failed = false;
  const disable = () => { failed = true; stream.destroy(); };
  stream.on('error', disable);
  let closed = false;
  const settled = new Promise<void>(resolve => stream.once('close', () => { closed = true; resolve(); }));
  return {
    write(event: SdkEvent) {
      if (failed || closed) return;
      try { if (!stream.write(JSON.stringify(event) + '\n')) disable(); } catch { disable(); }
    },
    async finish(): Promise<LogOutcome> {
      if (!failed) stream.end();
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([settled, new Promise<void>(resolve => { timer = setTimeout(() => { disable(); resolve(); }, 250); })]);
      if (timer) clearTimeout(timer);
      return { path, status: failed ? 'failed' : 'written' };
    },
  };
}
