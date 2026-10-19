import { Worker } from 'node:worker_threads';
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
/** Diagnostics never delay session saves or inference. One thread owns all record I/O. */
export class Records {
  private worker: Worker;
  private pending = 0;
  private failed = false;
  private recent: AppRecord[] = [];
  constructor(root: string, script: string | URL) {
    this.worker = new Worker(script, { workerData: { root, session: new Date().toISOString() } });
    this.worker.on('message', message => { if (message.written) this.pending = Math.max(0, this.pending - 1); });
    this.worker.on('error', error => { this.failed = true; process.stderr.write(`PicPatch records worker failed: ${String(error)}\n`); });
  }
  write(level: AppRecord['level'], message: string, details: Record<string, unknown> = {}) {
    const record: AppRecord = { ...details, time: new Date().toISOString(), level, message };
    this.recent.push(record); if (this.recent.length > 200) this.recent.shift();
    if (this.failed || this.pending >= 256) { process.stderr.write(JSON.stringify(record) + '\n'); return; }
    try { this.worker.postMessage(record); this.pending++; }
    catch { process.stderr.write(JSON.stringify(record) + '\n'); }
  }
  list(): AppRecord[] { return structuredClone(this.recent); }
  async close(): Promise<void> {
    await new Promise<void>(resolve => {
      const done = (message: any) => { if (message.flushed) { clearTimeout(timer); this.worker.off('message', done); resolve(); } };
      const timer = setTimeout(() => { this.worker.off('message', done); resolve(); }, 500);
      this.worker.on('message', done); this.worker.postMessage({ flush: true });
    });
    await this.worker.terminate();
  }
}
