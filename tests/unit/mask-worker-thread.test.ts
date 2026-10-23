import { Worker } from 'node:worker_threads';
import { expect, it } from 'vitest';
import type { MaskReply } from '../../src/renderer/src/mask/worker.ts';

it('executes the real worker entry off-thread and serializes later commands behind held encoding', async () => {
  const gate = new Int32Array(new SharedArrayBuffer(4));
  // Node lacks browser canvas. Only that platform edge is substituted; the real
  // worker dispatch, serial tail, editor, pixel kernel and reply transfer run.
  const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(`
    import { parentPort, workerData } from 'node:worker_threads';
    const gate = new Int32Array(workerData.gate);
    class Canvas {
      constructor(width, height) { this.width = width; this.height = height; this.pixels = new Uint8ClampedArray(width * height * 4); }
      getContext() { return {
        getImageData: () => ({ data: this.pixels.slice() }),
        putImageData: image => this.pixels.set(image.data),
        clearRect: () => this.pixels.fill(0),
      }; }
      async convertToBlob() {
        parentPort.postMessage({ entered: true });
        Atomics.wait(gate, 0, 0);
        return new Blob([this.pixels]);
      }
    }
    globalThis.OffscreenCanvas = Canvas;
    globalThis.postMessage = (reply, transfer) => parentPort.postMessage(reply, transfer);
    await import(${JSON.stringify(new URL('../../src/renderer/src/mask/worker.ts', import.meta.url).href)});
    parentPort.on('message', request => {
      if (request.command.kind === 'init') {
        const canvas = new Canvas(2, 1);
        canvas.pixels.set([242, 166, 90, 128, 242, 166, 90, 255]);
        request.command.canvas = canvas;
      }
      globalThis.onmessage({ data: request });
    });
  `)}`), { workerData: { gate: gate.buffer } });
  const replies: MaskReply[] = [];
  let entered!: () => void, completed!: () => void;
  const encoding = new Promise<void>(resolve => { entered = resolve; });
  const completion = new Promise<void>((resolve, reject) => {
    completed = resolve;
    worker.on('error', reject);
  });
  worker.on('message', (message: MaskReply | { entered: true }) => {
    if ('entered' in message) entered();
    else { replies.push(message); if (replies.length === 3) completed(); }
  });
  try {
    worker.postMessage({ id: 1, command: { kind: 'init' } });
    worker.postMessage({ id: 2, command: { kind: 'encode' } });
    await Promise.race([encoding, completion]);
    worker.postMessage({ id: 3, command: { kind: 'clear' } });
    // This turn proceeds while the worker itself is synchronously blocked.
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    expect(replies.map(reply => reply.id)).toEqual([1]);
    Atomics.store(gate, 0, 1); Atomics.notify(gate, 0);
    await completion;
    expect(replies.map(reply => reply.id)).toEqual([1, 2, 3]);
    expect('result' in replies[1]! && [...replies[1].result.bytes!]).toEqual([128, 128, 128, 255, 255, 255, 255, 255]);
  } finally {
    Atomics.store(gate, 0, 1); Atomics.notify(gate, 0);
    await worker.terminate();
  }
});
