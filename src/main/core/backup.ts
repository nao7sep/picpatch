import { Worker } from 'node:worker_threads';
export type BackupIssue = { kind: 'unavailable' } | { kind: 'capture'; diagnostic: string };
/**
 * Backup history: one worker thread captures each authored file's exact bytes into a database. A failure is
 * reported to the owner and never fails the save that asked for the capture.
 */
export class Backup {
  private worker: Worker;
  constructor(private database: string, script: string | URL, issue: (issue: BackupIssue) => void) {
    this.worker = new Worker(script);
    this.worker.on('error', () => issue({ kind: 'unavailable' }));
    this.worker.on('message', message => { if (message.issue) issue({ kind: 'capture', diagnostic: String(message.issue) }); });
  }
  capture(path: string, bytes: Buffer): void { this.worker.postMessage({ database: this.database, path, bytes }); }
  /** Captures already sent settle first, within a bound a stalled disk cannot extend; history is optional at quit. */
  async close(): Promise<void> {
    await new Promise<void>(resolve => {
      const done = (reply: { flushed?: string }) => { if (reply.flushed === 'quit') { clearTimeout(timer); this.worker.off('message', done); resolve(); } };
      const timer = setTimeout(() => { this.worker.off('message', done); resolve(); }, 500);
      this.worker.on('message', done); this.worker.postMessage({ flush: 'quit' });
    });
    await this.worker.terminate();
  }
  /** Stops at once, abandoning captures not yet written. */
  async terminate(): Promise<void> { await this.worker.terminate(); }
}
