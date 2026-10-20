import { Worker } from 'node:worker_threads';
import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fallbackLog } from './fallback-log.ts';
export interface AppRecord { time: string; level: 'debug' | 'info' | 'warn' | 'error'; message: string; [key: string]: unknown }
export function errorRecord(error: unknown): unknown {
  const seen = new Set<unknown>();
  function describe(value: unknown): unknown {
    if (!(value instanceof Error)) return String(value);
    if (seen.has(value)) return { name: value.name, message: 'Repeated cause' }; seen.add(value);
    const cause = value as Error & { code?: string; kind?: string; effect?: string; subject?: string; details?: unknown };
    return { name: cause.name, message: cause.message, stack: cause.stack, code: cause.code, kind: cause.kind, effect: cause.effect, subject: cause.subject, details: cause.details, ...(cause.cause ? { cause: describe(cause.cause) } : {}) };
  }
  return describe(error);
}
/** Diagnostics never delay session saves or inference. One thread owns all record I/O while it runs. */
export class Records {
  private worker: Worker;
  private pending = 0;
  private failed = false;
  readonly session = new Date().toISOString();
  private fallbackTail: Promise<void> = Promise.resolve();
  constructor(private root: string, script: string | URL, private changed: () => void = () => {}) {
    this.worker = new Worker(script, { workerData: { root, session: this.session } });
    this.worker.on('message', message => { if (message.written) { this.pending = Math.max(0, this.pending - 1); if (message.stored) this.changed(); } });
    this.worker.on('error', error => { this.failed = true; process.stderr.write(`PicPatch records worker failed: ${String(error)}\n`); });
  }
  write(level: AppRecord['level'], message: string, details: Record<string, unknown> = {}) {
    const record: AppRecord = { ...details, time: new Date().toISOString(), level, message };
    if (this.failed || this.pending >= 256) { this.fallback(record); return; }
    try { this.worker.postMessage(record); this.pending++; }
    catch { this.fallback(record); }
  }
  /** Without a working writer, records go to the launch's fallback log in order, and to stderr only when that fails. */
  private fallback(record: AppRecord) {
    const line = JSON.stringify(record) + '\n', path = fallbackLog(this.root, this.session);
    this.fallbackTail = this.fallbackTail
      .then(async () => { await mkdir(join(this.root, 'logs'), { recursive: true, mode: 0o700 }); await appendFile(path, line, { mode: 0o600 }); })
      .catch(() => { process.stderr.write(line); });
  }
  async close(): Promise<void> {
    await new Promise<void>(resolve => {
      const done = (message: any) => { if (message.flushed) { clearTimeout(timer); this.worker.off('message', done); resolve(); } };
      const timer = setTimeout(() => { this.worker.off('message', done); resolve(); }, 500);
      this.worker.on('message', done); this.worker.postMessage({ flush: true });
    });
    await this.worker.terminate(); await this.fallbackTail;
  }
}
