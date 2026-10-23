import { Worker } from 'node:worker_threads';
import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { totalmem } from 'node:os';
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
type PendingRecord = { id: number; line: string; bytes: number; notify: boolean };
/** Diagnostics have one bounded admission budget, including worker writes and fallback I/O. */
export class Records {
  private worker: Worker;
  private queue: PendingRecord[] = [];
  private active?: PendingRecord;
  private bytes = 0;
  private sequence = 0;
  private failed = false;
  private closed = false;
  private terminating = false;
  private overloaded = false;
  private closing?: Promise<boolean>;
  private idle?: () => void;
  private watchdog?: ReturnType<typeof setTimeout>;
  // Small relative to host RAM; a stalled optional sink must not retain unlimited diagnostics.
  private readonly budget = Math.min(32 * 1024 * 1024, Math.floor(totalmem() / 1024));
  readonly session = new Date().toISOString();
  constructor(private root: string, script: string | URL, private changed: () => void = () => {}) {
    this.worker = new Worker(script, { workerData: { root, session: this.session } });
    this.worker.on('message', message => {
      if (!this.failed && message.written && this.active && this.active.id === message.id) {
        if (message.stored && this.active.notify) this.changed();
        this.complete();
      }
    });
    this.worker.on('error', error => this.workerFailed(error));
    this.worker.on('exit', code => { if (!this.terminating) this.workerFailed(new Error(`Records writer exited (${code}).`)); });
  }
  write(level: AppRecord['level'], message: string, details: Record<string, unknown> = {}) {
    this.admit(level, message, details, true);
  }
  /** Retain the failed read for inspection without its own ACK restarting that read. */
  readFailed(error: unknown) { this.admit('error', 'Records could not be read.', { error: errorRecord(error) }, false); }
  private admit(level: AppRecord['level'], message: string, details: Record<string, unknown>, notify: boolean) {
    if (this.closed) return;
    let line: string;
    try { line = JSON.stringify({ ...details, time: new Date().toISOString(), level, message }) + '\n'; }
    catch (error) { process.stderr.write(`PicPatch record could not be serialized: ${String(error)}\n`); return; }
    const bytes = Buffer.byteLength(line);
    if (this.queue.length + Number(!!this.active) >= 256 || this.bytes + bytes > this.budget) {
      if (!this.overloaded) process.stderr.write('PicPatch records unavailable: diagnostic buffer full; recent records may be omitted.\n');
      this.overloaded = true; return;
    }
    this.overloaded = false; this.bytes += bytes;
    this.queue.push({ id: ++this.sequence, line, bytes, notify }); this.pump();
  }
  private pump() {
    if (this.active) return;
    this.active = this.queue.shift();
    if (!this.active) { this.idle?.(); return; }
    if (this.failed) { this.fallback(this.active); return; }
    try {
      this.worker.postMessage({ id: this.active.id, record: JSON.parse(this.active.line) });
      this.watchdog = setTimeout(() => this.workerFailed(new Error('Records writer stopped acknowledging writes.')), 2000);
      this.watchdog.unref();
    } catch (error) { this.workerFailed(error); }
  }
  private workerFailed(error: unknown) {
    if (this.failed) return;
    this.failed = true; clearTimeout(this.watchdog);
    process.stderr.write(`PicPatch records worker failed: ${String(error)}\n`);
    // An unknown ACK may duplicate a stored record. Optional diagnostics do not promise exactly-once delivery.
    if (this.active) this.fallback(this.active);
    void this.worker.terminate().catch(error => process.stderr.write(`PicPatch records worker termination failed: ${String(error)}\n`));
  }
  private fallback(entry: PendingRecord) {
    void (async () => {
      try {
        await mkdir(join(this.root, 'logs'), { recursive: true, mode: 0o700 });
        await appendFile(fallbackLog(this.root, this.session), entry.line, { mode: 0o600 });
      } catch { process.stderr.write(entry.line); }
      finally { this.complete(); }
    })();
  }
  private complete() {
    clearTimeout(this.watchdog);
    if (this.active) this.bytes -= this.active.bytes;
    this.active = undefined; this.pump();
  }
  close(): Promise<boolean> {
    return this.closing ??= this.finish();
  }
  private async finish() {
    this.closed = true;
    const deadline = performance.now() + 500;
    await new Promise<void>(resolve => {
      const timer = setTimeout(resolve, 500);
      this.idle = () => { clearTimeout(timer); resolve(); };
      if (!this.active) this.idle();
    });
    clearTimeout(this.watchdog);
    this.queue = []; this.bytes = this.active?.bytes ?? 0;
    // Termination and a stalled fallback remain best effort after the single total flush bound.
    this.terminating = true;
    const terminated = await new Promise<boolean>(resolve => {
      const timer = setTimeout(() => resolve(false), Math.max(0, deadline - performance.now()));
      void this.worker.terminate().then(() => { clearTimeout(timer); resolve(true); }, error => {
        process.stderr.write(`PicPatch records worker termination failed: ${String(error)}\n`);
        clearTimeout(timer); resolve(false);
      });
    });
    return terminated && performance.now() < deadline && !(this.failed && this.active);
  }
}
