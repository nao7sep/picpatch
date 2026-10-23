import type { MaskCommand, MaskResult } from './editor.ts';
import type { MaskReply, MaskRequest } from './worker.ts';

type WorkerPort = Pick<Worker, 'postMessage' | 'terminate' | 'onmessage' | 'onerror' | 'onmessageerror'>;

/** Close seals admission, then joins replies before releasing the worker. */
export class MaskWorker {
  private next = 0;
  private closing = false;
  private failed?: Error;
  private pending = new Map<number, { resolve: (result: MaskResult) => void; reject: (error: Error) => void }>();
  private disposed?: Promise<void>;
  private drained?: () => void;

  constructor(private readonly worker: WorkerPort) {
    worker.onmessage = event => {
      const reply = event.data as MaskReply, pending = this.pending.get(reply.id);
      if (!pending) return;
      this.pending.delete(reply.id);
      if ('error' in reply) { const error = new Error(reply.error.message); error.stack = reply.error.stack; pending.reject(error); }
      else pending.resolve(reply.result);
      if (!this.pending.size) this.drained?.();
    };
    worker.onerror = event => { event.preventDefault(); this.fail(new Error(event.message)); };
    worker.onmessageerror = () => this.fail(new Error('Could not read mask worker response'));
  }

  run(command: MaskCommand, transfer: Transferable[] = []) {
    if (this.closing || this.failed) return Promise.reject(this.failed ?? new Error('Mask worker is closed'));
    return new Promise<MaskResult>((resolve, reject) => {
      const id = ++this.next;
      this.pending.set(id, { resolve, reject });
      try { this.worker.postMessage({ id, command } satisfies MaskRequest, transfer); }
      catch (error) { this.pending.delete(id); reject(error); }
    });
  }

  close() {
    if (this.disposed) return this.disposed;
    this.closing = true;
    this.disposed = (this.pending.size ? new Promise<void>(resolve => { this.drained = resolve; }) : Promise.resolve())
      .then(() => { this.worker.terminate(); });
    return this.disposed;
  }

  private fail(error: Error) {
    this.failed = error;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear(); this.drained?.();
    void this.close();
  }
}
