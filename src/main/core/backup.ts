import { Worker } from 'node:worker_threads';
export type BackupIssue = { kind: 'unavailable' } | { kind: 'capture'; diagnostic: string };
/**
 * Backup history: one worker thread captures each authored file's exact bytes into a database, every save in save
 * order. A failure is reported to the owner and never fails the save that asked for the capture.
 */
export class Backup {
  private worker: Worker;
  /** Captures sent and not yet written. */
  private outstanding = 0;
  private stopped = false;
  private idle?: () => void;
  constructor(private database: string, script: string | URL, private issue: (issue: BackupIssue) => void) {
    this.worker = new Worker(script);
    this.worker.on('error', () => this.unavailable());
    this.worker.on('exit', () => this.unavailable());
    this.worker.on('message', message => {
      if (!message.written) return;
      this.outstanding--;
      if (message.issue) this.issue({ kind: 'capture', diagnostic: String(message.issue) });
      if (this.outstanding === 0) this.idle?.();
    });
  }
  /** The bytes are copied as they are sent, so the caller keeps its buffer. */
  capture(path: string, bytes: Buffer): void {
    if (this.stopped) return;
    try { this.worker.postMessage({ database: this.database, path, bytes }); this.outstanding++; } catch { this.unavailable(); }
  }
  private unavailable() {
    if (this.stopped) return;
    this.stopped = true; this.outstanding = 0;
    this.issue({ kind: 'unavailable' }); this.idle?.();
  }
  /** Captures already sent settle first; the quit's exit deadline bounds the wait. */
  async close(): Promise<void> {
    await new Promise<void>(resolve => {
      this.idle = resolve;
      if (this.outstanding === 0 || this.stopped) resolve();
    });
    await this.terminate();
  }
  /** Stops at once, abandoning captures not yet written. */
  async terminate(): Promise<void> { this.stopped = true; await this.worker.terminate(); }
}
