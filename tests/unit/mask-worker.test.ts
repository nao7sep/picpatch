import { expect, it, vi } from 'vitest';
import { MaskWorker } from '../../src/renderer/src/mask/client.ts';
import type { MaskReply, MaskRequest } from '../../src/renderer/src/mask/worker.ts';

class Port {
  onmessage: Worker['onmessage'] = null;
  onerror: Worker['onerror'] = null;
  onmessageerror: Worker['onmessageerror'] = null;
  terminate = vi.fn();
  requests: MaskRequest[] = [];
  transfers: Transferable[][] = [];
  postMessage(request: MaskRequest, transfer: Transferable[]) { this.requests.push(request); this.transfers.push(transfer); }
  reply(reply: MaskReply) { this.onmessage?.call(this as unknown as Worker, { data: reply } as MessageEvent); }
}

it('seals admission and retains the worker until every accepted command actually replies', async () => {
  const port = new Port(), worker = new MaskWorker(port as unknown as Worker);
  const first = worker.run({ kind: 'clear' });
  const encode = worker.run({ kind: 'encode' });
  const closing = worker.close();
  expect(worker.close()).toBe(closing);
  await expect(worker.run({ kind: 'undo' })).rejects.toThrow('closed');
  expect(port.terminate).not.toHaveBeenCalled();
  port.reply({ id: port.requests[0]!.id, result: { undo: true, redo: false } });
  await first;
  expect(port.terminate).not.toHaveBeenCalled();
  const bytes = new Uint8Array([1, 2, 3]);
  port.reply({ id: port.requests[1]!.id, result: { undo: true, redo: false, bytes } });
  expect((await encode).bytes).toBe(bytes);
  await closing;
  expect(port.terminate).toHaveBeenCalledOnce();
});

it('transfers initialization resources and settles failed commands before termination', async () => {
  const port = new Port(), worker = new MaskWorker(port as unknown as Worker);
  const canvas = {} as OffscreenCanvas, bitmap = {} as ImageBitmap;
  const init = worker.run({ kind: 'init', canvas, mask: bitmap }, [canvas, bitmap]);
  expect(port.transfers[0]).toEqual([canvas, bitmap]);
  const rejected = expect(init).rejects.toThrow('diagnostic sentinel');
  const closing = worker.close();
  port.reply({ id: port.requests[0]!.id, error: { message: 'diagnostic sentinel' } });
  await rejected; await closing;
  expect(port.terminate).toHaveBeenCalledOnce();
});

it('joins a failed worker and rejects all pending callers instead of leaving close hanging', async () => {
  const port = new Port(), worker = new MaskWorker(port as unknown as Worker);
  const request = worker.run({ kind: 'encode' });
  const rejected = expect(request).rejects.toThrow('Worker stopped');
  const closing = worker.close();
  const preventDefault = vi.fn();
  port.onerror?.call(port as unknown as Worker, { message: 'Worker stopped', preventDefault } as unknown as ErrorEvent);
  await rejected; await closing;
  expect(preventDefault).toHaveBeenCalledOnce();
  expect(port.terminate).toHaveBeenCalledOnce();
});
