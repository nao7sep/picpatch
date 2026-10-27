import { Worker } from 'node:worker_threads';
import type { RecordsQuery, RecordsPage } from '../../shared/records.ts';
/** Reads cannot queue behind a stalled writer, or hold up inference and shutdown. */
export class RecordsReader {
  private worker?: Worker;
  private serial = 0;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  constructor(private root: string, private session: string, private script: string | URL) {}
  private stop(error: Error) {
    const worker = this.worker; this.worker = undefined;
    for (const task of this.pending.values()) { clearTimeout(task.timer); task.reject(error); }
    this.pending.clear();
    if (worker) void worker.terminate();
  }
  private request(action: string, payload: unknown): Promise<any> {
    if (!this.worker) {
      const worker = this.worker = new Worker(this.script, { workerData: { root: this.root, session: this.session } });
      worker.on('message', reply => {
        const task = this.pending.get(reply.id); if (!task || worker !== this.worker) return;
        clearTimeout(task.timer); this.pending.delete(reply.id);
        if (reply.error) task.reject(Object.assign(new Error(reply.error.message), reply.error)); else task.resolve(reply.value);
      });
      worker.on('error', error => { if (worker === this.worker) this.stop(error instanceof Error ? error : new Error(String(error))); });
      worker.on('exit', () => { if (worker === this.worker) this.stop(new Error('Records reader stopped.')); });
    }
    return new Promise((resolve, reject) => {
      const id = ++this.serial;
      const timer = setTimeout(() => this.stop(new Error('Records read timed out.')), 5000);
      this.pending.set(id, { resolve, reject, timer });
      try { this.worker!.postMessage({ id, action, payload }); }
      catch (error) { this.stop(error instanceof Error ? error : new Error(String(error))); }
    });
  }
  query(query: RecordsQuery): Promise<RecordsPage> { return this.request('query', query); }
  detail(id: number): Promise<string | null> { return this.request('detail', id); }
  async close(): Promise<void> { const worker = this.worker; this.stop(new Error('Records reader closed.')); if (worker) await worker.terminate(); }
}
