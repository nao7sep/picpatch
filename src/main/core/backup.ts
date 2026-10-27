import { Worker } from 'node:worker_threads';
export type BackupIssue = { kind: 'unavailable' } | { kind: 'capture'; diagnostic: string };
/**
 * Backup history: one worker thread captures each authored file's exact bytes into a database. One snapshot is in
 * flight at a time and a newer save of a path replaces its older pending snapshot. A failure is reported to the owner
 * and never fails the save that asked for the capture.
 */
export class Backup {
  private worker: Worker;
  private pending = new Map<string, Buffer>();
  private active = false;
  private stopped = false;
  private idle?: () => void;
  constructor(private database: string, script: string | URL, private issue: (issue: BackupIssue) => void) {
    this.worker = new Worker(script);
    this.worker.on('error', () => this.unavailable());
    this.worker.on('exit', () => this.unavailable());
    this.worker.on('message', message => {
      if (!message.written) return;
      this.active = false;
      if (message.issue) this.issue({ kind: 'capture', diagnostic: String(message.issue) });
      this.pump();
    });
  }
  capture(path: string, bytes: Buffer): void {
    if (this.stopped) return;
    this.pending.delete(path); this.pending.set(path, Buffer.from(bytes));
    this.pump();
  }
  private pump() {
    if (this.active || this.stopped) return;
    const next = this.pending.entries().next().value;
    if (!next) { this.idle?.(); return; }
    const [path, bytes] = next;
    this.pending.delete(path); this.active = true;
    try { this.worker.postMessage({ database: this.database, path, bytes }); } catch { this.unavailable(); }
  }
  private unavailable() {
    if (this.stopped) return;
    this.stopped = true; this.pending.clear(); this.active = false;
    this.issue({ kind: 'unavailable' }); this.idle?.();
  }
  /** Captures already accepted settle first, within a bound a stalled disk cannot extend; history is optional at quit. */
  async close(): Promise<void> {
    await new Promise<void>(resolve => {
      const timer = setTimeout(resolve, 500);
      this.idle = () => { clearTimeout(timer); resolve(); };
      if (!this.active || this.stopped) this.idle();
    });
    await this.terminate();
  }
  /** Stops at once, abandoning captures not yet written. */
  async terminate(): Promise<void> { this.stopped = true; this.pending.clear(); await this.worker.terminate(); }
}
