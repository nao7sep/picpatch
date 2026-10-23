import { Worker } from 'node:worker_threads';
import type { Session } from '../../shared/session.ts';

/** One worker retains the last encoded history; draft saves send only changed metadata. */
export class SessionEncoder {
  private worker?: Worker;
  private previous?: Session;
  private tail: Promise<unknown> = Promise.resolve();
  encode(session: Session): Promise<Buffer> {
    const next = this.tail.then(() => this.write(session));
    this.tail = next.catch(() => {}); return next;
  }
  private async write(session: Session): Promise<Buffer> {
    const worker = this.worker ??= new Worker(`
      const { parentPort } = require('node:worker_threads');
      let current;
      parentPort.on('message', value => {
        try {
          current = value.full || { ...current, ...value.patch };
          const bytes = new TextEncoder().encode(JSON.stringify(current, null, 2) + '\\n');
          parentPort.postMessage({ bytes }, [bytes.buffer]);
        } catch (error) { parentPort.postMessage({ error: String(error) }); }
      });
    `, { eval: true });
    worker.ref();
    const sameHistory = this.previous?.id === session.id && this.previous.runs === session.runs && this.previous.assets === session.assets;
    const { runs: _runs, assets: _assets, ...patch } = session;
    try {
      const bytes = await new Promise<Buffer>((resolve, reject) => {
        const clean = () => { worker.off('message', message); worker.off('error', error); worker.off('exit', exit); };
        const message = (result: { bytes?: Uint8Array; error?: string }) => { clean(); result.bytes ? resolve(Buffer.from(result.bytes.buffer, result.bytes.byteOffset, result.bytes.byteLength)) : reject(new Error(result.error)); };
        const error = (error: Error) => { clean(); reject(error); };
        const exit = () => { clean(); reject(new Error('Session encoder stopped before finishing.')); };
        worker.once('message', message); worker.once('error', error); worker.once('exit', exit);
        try { worker.postMessage(sameHistory ? { patch } : { full: session }); } catch (cause) { clean(); reject(cause); }
      });
      this.previous = session;
      return bytes;
    } catch (error) { this.previous = undefined; this.worker = undefined; void worker.terminate(); throw error; }
    finally { worker.unref(); }
  }
  close(): void { const worker = this.worker; this.worker = undefined; this.previous = undefined; if (worker) void worker.terminate(); }
}

export const sessionEncoder = new SessionEncoder();
