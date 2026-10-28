import { Worker } from 'node:worker_threads';
import type { RecordsQuery, RecordsPage } from '../../shared/records.ts';
/**
 * Reads records.sqlite3 for the Records window on one worker thread, started at the first read, so reads never queue
 * behind the writer or hold up inference. A local read gets no timeout; a worker that fails or exits fails its waiting
 * reads and is replaced at the next read.
 */
export class RecordsReader {
  private worker?: Worker;
  private serial = 0;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  constructor(private root: string, private session: string, private script: string | URL) {}
  private stop(error: Error) {
    const worker = this.worker; this.worker = undefined;
    // A replaced worker's own exit has nothing left to fail.
    worker?.removeAllListeners('exit');
    for (const task of this.pending.values()) task.reject(error);
    this.pending.clear();
    return worker?.terminate();
  }
  private request(action: string, payload: unknown): Promise<any> {
    if (!this.worker) {
      const worker = this.worker = new Worker(this.script, { workerData: { root: this.root, session: this.session } });
      worker.on('message', reply => {
        const task = this.pending.get(reply.id); if (!task) return;
        this.pending.delete(reply.id);
        if (reply.error) task.reject(Object.assign(new Error(reply.error.message), reply.error)); else task.resolve(reply.value);
      });
      worker.on('error', error => { void this.stop(error instanceof Error ? error : new Error(String(error))); });
      worker.on('exit', () => { void this.stop(new Error('Records reader stopped.')); });
    }
    return new Promise((resolve, reject) => {
      const id = ++this.serial;
      this.pending.set(id, { resolve, reject });
      try { this.worker!.postMessage({ id, action, payload }); }
      catch (error) { void this.stop(error instanceof Error ? error : new Error(String(error))); }
    });
  }
  query(query: RecordsQuery): Promise<RecordsPage> { return this.request('query', query); }
  detail(id: number): Promise<string | null> { return this.request('detail', id); }
  /** The quit's exit deadline bounds the wait. */
  async close(): Promise<void> { await this.stop(new Error('Records reader closed.')); }
}
