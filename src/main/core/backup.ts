import { Worker } from 'node:worker_threads';
import { totalmem } from 'node:os';
export type BackupIssue = { kind: 'unavailable' } | { kind: 'capture'; diagnostic: string };
type Snapshot = { path: string; bytes: Buffer };
/** Optional history has one acknowledged writer and keeps only each path's newest pending save. */
export class Backup {
  private worker: Worker;
  private pending = new Map<string, Snapshot>();
  private active?: { id: number; bytes: number };
  private resident = 0;
  private sequence = 0;
  private stopped = false;
  private closed = false;
  private warned = false;
  private closing?: Promise<boolean>;
  private idle?: () => void;
  private watchdog?: ReturnType<typeof setTimeout>;
  // Derive payload capacity from host RAM; history may omit a snapshot beyond its optional budget.
  private readonly budget = Math.min(128 * 1024 * 1024, Math.floor(totalmem() / 256));
  constructor(private database: string, script: string | URL, private issue: (issue: BackupIssue) => void) {
    this.worker = new Worker(script);
    this.worker.on('error', () => this.unavailable());
    this.worker.on('exit', () => { if (!this.closed || this.active) this.unavailable(); });
    this.worker.on('message', message => {
      if (message.written && this.active && this.active.id === message.id) {
        clearTimeout(this.watchdog);
        this.resident -= this.active.bytes; this.active = undefined;
        if (message.issue) this.issue({ kind: 'capture', diagnostic: String(message.issue) });
        this.pump();
      }
    });
  }
  capture(path: string, bytes: Buffer): void {
    if (this.closed || this.stopped) return;
    const previous = this.pending.get(path);
    // A newer save supersedes an older pending snapshot even when the new one cannot be admitted.
    if (previous) { this.resident -= previous.bytes.length; this.pending.delete(path); }
    if (this.pending.size + Number(!!this.active) >= 256 || this.resident + bytes.length > this.budget) {
      if (!this.warned) this.issue({ kind: 'unavailable' });
      this.warned = true; return;
    }
    this.warned = false;
    this.pending.set(path, { path, bytes: Buffer.from(bytes) }); this.resident += bytes.length;
    this.pump();
  }
  private pump() {
    if (this.active || this.stopped) return;
    const next = this.pending.values().next().value;
    if (!next) { this.idle?.(); return; }
    this.pending.delete(next.path);
    this.active = { id: ++this.sequence, bytes: next.bytes.length };
    try {
      this.worker.postMessage({ id: this.active.id, database: this.database, ...next });
      this.watchdog = setTimeout(() => this.unavailable(), 2000); this.watchdog.unref();
    } catch { this.unavailable(); }
  }
  private unavailable() {
    if (this.stopped) return;
    this.stopped = true; clearTimeout(this.watchdog);
    this.pending.clear(); this.resident = 0; this.active = undefined;
    this.issue({ kind: 'unavailable' }); this.idle?.();
    void this.worker.terminate().catch(error => this.issue({ kind: 'capture', diagnostic: String(error) }));
  }
  /** History gets one short total drain bound, including an unresponsive worker's termination. */
  close(): Promise<boolean> { return this.closing ??= this.finish(); }
  private async finish() {
    this.closed = true;
    const deadline = performance.now() + 500;
    await new Promise<void>(resolve => {
      const timer = setTimeout(resolve, 500);
      this.idle = () => { clearTimeout(timer); resolve(); };
      if (!this.active || this.stopped) this.idle();
    });
    const terminated = await this.terminate(Math.max(0, deadline - performance.now()));
    return terminated && performance.now() < deadline;
  }
  /** Request termination without joining a potentially stalled worker. */
  async terminate(wait = 100): Promise<boolean> {
    this.closed = true; this.stopped = true; clearTimeout(this.watchdog);
    this.pending.clear(); this.resident = 0; this.active = undefined; this.idle?.();
    return new Promise<boolean>(resolve => {
      const timer = setTimeout(() => resolve(false), wait);
      void this.worker.terminate().then(() => { clearTimeout(timer); resolve(true); }, error => {
        this.issue({ kind: 'capture', diagnostic: String(error) });
        clearTimeout(timer); resolve(false);
      });
    });
  }
}
