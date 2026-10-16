import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEditor, type EditRequest } from '../../src/index.ts';
import { ProcessEditor } from '../../src/execution/worker-backend.ts';
import { WorkerProcess, type WorkerTimeouts } from '../../src/worker/process.ts';
import type { WorkerRequest } from '../../src/worker/protocol.ts';

const timeouts: WorkerTimeouts = { startupMs: 100, editMs: 100, cancellationMs: 20, shutdownMs: 20, terminationMs: 10 };
const request: EditRequest = { model: 'test', instruction: 'Edit', sourceImage: '/in.png', outputPath: '/out.png', seed: 1 };
const capabilities = { model: 'test', instructionEditing: true, referenceRoles: ['subject'], maskMode: 'none' };
const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

class FakeWorker extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly requests: WorkerRequest[] = [];
  readonly signals: NodeJS.Signals[] = [];
  closed = false;
  ignoreTerm = false;
  onRequest: (request: WorkerRequest) => void = message => {
    if (message.type === 'hello') this.reply(message.id, 'ready', { workerVersion: 'test', models: [capabilities] });
    if (message.type === 'shutdown') { this.reply(message.id, 'shutdownAck'); this.close(); }
  };
  readonly stdin = new Writable({ write: (chunk, _encoding, done) => {
    const message = JSON.parse(chunk.toString()) as WorkerRequest;
    this.requests.push(message);
    queueMicrotask(() => this.onRequest(message));
    done();
  } });
  kill(signal: NodeJS.Signals): boolean {
    this.signals.push(signal);
    if (signal !== 'SIGTERM' || !this.ignoreTerm) this.close();
    return true;
  }
  reply(id: number, type: string, fields: object = {}) { this.stdout.write(JSON.stringify({ version: 1, id, type, ...fields })+'\n'); }
  result(id: number) { this.reply(id, 'result', { result: { image: { path: '/out.png', mimeType: 'image/png', size: { width: 64, height: 64 } }, model: 'test', modelRevision: 'rev', runtime: { name: 'fake', version: '1' }, seed: 1, references: [] } }); }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.emit('exit', 0, null);
    this.stdout.end(); this.stderr.end();
    queueMicrotask(() => this.emit('close', 0, null));
  }
}
function setup() {
  const child = new FakeWorker();
  const spawn = vi.fn(() => child as unknown as ChildProcessWithoutNullStreams);
  const worker = new WorkerProcess({ executable: '/python', args: [], cwd: '/' }, timeouts, spawn);
  return { child, spawn, worker, editor: new ProcessEditor(worker) };
}
afterEach(() => vi.useRealTimers());

describe('owned worker lifecycle', () => {
  it('starts lazily, reuses its worker, forwards progress, and closes idempotently', async () => {
    const { child, spawn, editor } = setup();
    expect(spawn).not.toHaveBeenCalled();
    const base = child.onRequest;
    child.onRequest = message => { base(message); if (message.type === 'edit') {
      child.reply(message.id, 'progress', { event: { type: 'progress', verb: 'edit', stage: 'editing', message: 'Editing' } });
      child.result(message.id);
    } };
    const onProgress = vi.fn();
    expect((await editor.edit(request, { onProgress })).seed).toBe(1);
    await editor.edit(request);
    expect(onProgress).toHaveBeenCalledOnce();
    expect(spawn).toHaveBeenCalledOnce();
    const first = editor.dispose(); expect(editor.dispose()).toBe(first); await first;
    expect(child.closed).toBe(true);
    expect(child.requests.map(message => message.type)).toEqual(['hello', 'edit', 'edit', 'shutdown']);
    await expect(editor.edit(request)).rejects.toMatchObject({ code: 'DISPOSED' });
  });
  it('rejects overlapping work before startup completes', async () => {
    const { child, editor } = setup();
    const active = editor.edit(request); const caught = expect(active).rejects.toMatchObject({ code: 'CANCELLED' });
    await expect(editor.edit(request)).rejects.toMatchObject({ code: 'BUSY' });
    await editor.dispose(); await caught; expect(child.closed).toBe(true);
  });
  it('does not start for invalid or already cancelled work, or dispose before use', async () => {
    const { editor, spawn } = setup();
    const controller = new AbortController(); controller.abort();
    await expect(editor.edit(request, { signal: controller.signal })).rejects.toMatchObject({ code: 'CANCELLED' });
    await expect(editor.edit({ ...request, seed: -1 })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await editor.dispose(); expect(spawn).not.toHaveBeenCalled();
  });
  it('settles cancellation only after an edit terminal reply', async () => {
    const { editor, child } = setup(); const controller = new AbortController();
    let settled = false;
    const active = editor.edit(request, { signal: controller.signal });
    void active.then(() => { settled = true; }, () => { settled = true; });
    const caught = expect(active).rejects.toMatchObject({ code: 'CANCELLED' });
    await tick(); controller.abort(); await tick();
    const cancel = child.requests.find(message => message.type === 'cancel')!;
    child.reply(cancel.id, 'cancelAck', { targetId: 2, accepted: true });
    await tick(); expect(settled).toBe(false);
    child.reply(2, 'error', { error: { code: 'CANCELLED', message: 'Cancelled' } });
    await caught; await editor.dispose(); expect(child.closed).toBe(true);
  });
  it('preserves a successful result racing with cancellation', async () => {
    const { editor, child } = setup(); const controller = new AbortController();
    const active = editor.edit(request, { signal: controller.signal }); await tick();
    controller.abort(); await tick(); child.result(2);
    child.reply(3, 'cancelAck', { targetId: 2, accepted: false });
    expect((await active).seed).toBe(1); await editor.dispose();
  });
  it('terminates an unresponsive cancellation and waits for forced exit', async () => {
    vi.useFakeTimers(); const { editor, child } = setup(); child.ignoreTerm = true;
    const controller = new AbortController(); const active = editor.edit(request, { signal: controller.signal });
    const caught = expect(active).rejects.toMatchObject({ code: 'CANCELLED' });
    await vi.advanceTimersByTimeAsync(0); controller.abort();
    await vi.advanceTimersByTimeAsync(20); expect(child.closed).toBe(false);
    await vi.advanceTimersByTimeAsync(10); await caught;
    expect(child.signals).toEqual(['SIGTERM', 'SIGKILL']); expect(child.closed).toBe(true); await editor.dispose();
  });
  it('aborts startup and never sends an edit', async () => {
    const { editor, child } = setup(); child.onRequest = () => {};
    const controller = new AbortController(); const active = editor.edit(request, { signal: controller.signal });
    const caught = expect(active).rejects.toMatchObject({ code: 'CANCELLED' });
    controller.abort(); await caught; expect(child.closed).toBe(true);
    expect(child.requests.map(message => message.type)).toEqual(['hello']); await editor.dispose();
  });
  it.each(['startup', 'edit'])('times out %s without releasing a live worker', async phase => {
    vi.useFakeTimers(); const { editor, child } = setup(); if (phase === 'startup') child.onRequest = () => {};
    const active = editor.edit(request); const caught = expect(active).rejects.toMatchObject({ code: 'TIMEOUT' });
    await vi.advanceTimersByTimeAsync(100); await caught; expect(child.closed).toBe(true); await editor.dispose();
  });
  it.each(['bad JSON\n', '{"version":1,"id":99,"type":"shutdownAck"}\n'])('closes after invalid output: %s', async output => {
    const { editor, child } = setup(); const active = editor.edit(request);
    const caught = expect(active).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' });
    await tick(); child.stdout.write(output); await caught; expect(child.closed).toBe(true); await editor.dispose();
  });
  it('handles unexpected exit and does not silently restart', async () => {
    const { editor, child, spawn } = setup(); const active = editor.edit(request);
    const caught = expect(active).rejects.toBeInstanceOf(Error); await tick(); child.close(); await caught;
    await expect(editor.edit(request)).rejects.toBeInstanceOf(Error);
    expect(spawn).toHaveBeenCalledOnce(); await editor.dispose();
  });
  it('handles spawn failure', async () => {
    const { editor, child } = setup(); child.onRequest = () => {};
    const active = editor.edit(request); const caught = expect(active).rejects.toMatchObject({ code: 'WORKER_UNAVAILABLE' });
    child.emit('error', new Error('spawn failed')); await caught; expect(child.closed).toBe(true); await editor.dispose();
  });
  it('contains progress callback exceptions and stops the producer', async () => {
    const { editor, child } = setup(); const active = editor.edit(request, { onProgress: () => { throw new Error('caller'); } });
    const caught = expect(active).rejects.toMatchObject({ code: 'CALLBACK_FAILED' }); await tick();
    child.reply(2, 'progress', { event: { type: 'progress', verb: 'edit', stage: 'editing', message: 'Editing' } });
    await caught; expect(child.closed).toBe(true); await editor.dispose();
  });
  it('disposes an active edit only after process close', async () => {
    const { editor, child } = setup(); const active = editor.edit(request); const caught = expect(active).rejects.toMatchObject({ code: 'CANCELLED' });
    await tick(); await editor.dispose(); await caught; expect(child.closed).toBe(true);
  });
  it('times out a worker that acknowledges shutdown but does not exit', async () => {
    vi.useFakeTimers(); const { editor, child } = setup();
    child.onRequest = message => {
      if (message.type === 'hello') child.reply(message.id, 'ready', { workerVersion: 'test', models: [] });
      if (message.type === 'shutdown') child.reply(message.id, 'shutdownAck');
    };
    await expect(editor.edit(request)).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
    const disposal = editor.dispose(); const caught = expect(disposal).rejects.toMatchObject({ code: 'TIMEOUT' });
    await vi.advanceTimersByTimeAsync(20); await caught; expect(child.closed).toBe(true);
  });
  it('validates public factory configuration without starting a process', async () => {
    expect(() => createEditor({ pythonExecutable: 'python' })).toThrow();
    expect(() => createEditor({ pythonExecutable: '/python', timeouts: { startupMs: 0 } })).toThrow();
    await createEditor({ pythonExecutable: '/python' }).dispose();
  });
});

describe('transport boundaries', () => {
  it('decodes split UTF-8 bytes and multiple frames', async () => {
    const { editor, child } = setup();
    const onProgress = vi.fn(); const active = editor.edit(request, { onProgress }); await tick();
    const frame = Buffer.from(JSON.stringify({ version: 1, id: 2, type: 'progress', event: { type: 'progress', verb: 'edit', stage: 'editing', message: '日本語' } })+'\n');
    const split = frame.indexOf(Buffer.from('日')) + 1;
    child.stdout.write(frame.subarray(0, split)); child.stdout.write(frame.subarray(split)); child.result(2);
    await active; expect(onProgress.mock.calls[0]![0].message).toBe('日本語'); await editor.dispose();
  });
  it('rejects invalid UTF-8 and cleans up', async () => {
    const { editor, child } = setup(); const active = editor.edit(request); const caught = expect(active).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' });
    await tick(); child.stdout.write(Buffer.from([0xff])); await caught; expect(child.closed).toBe(true); await editor.dispose();
  });
  it('closes on a rejected handshake', async () => {
    const { editor, child } = setup(); child.onRequest = message => child.reply(message.id, 'error', { error: { code: 'RUNTIME_FAILURE', message: 'Unavailable' } });
    await expect(editor.edit(request)).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' }); expect(child.closed).toBe(true); await editor.dispose();
  });
  it('contains a synchronous spawn exception', async () => {
    const worker = new WorkerProcess({ executable: '/python', args: [], cwd: '/' }, timeouts, () => { throw new Error('spawn'); });
    const editor = new ProcessEditor(worker); await expect(editor.edit(request)).rejects.toMatchObject({ code: 'WORKER_UNAVAILABLE' }); await editor.dispose();
  });
  it('does not accept a result for a different output', async () => {
    const { editor, child } = setup(); const active = editor.edit({ ...request, outputPath: '/different.png' });
    const caught = expect(active).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' }); await tick(); child.result(2); await caught; expect(child.closed).toBe(true); await editor.dispose();
  });
  it('keeps diagnostics out of caller streams and out of response parsing', async () => {
    const { editor, child } = setup(); const active = editor.edit(request); await tick();
    child.stderr.write('private diagnostic\n'); child.result(2); await active;
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(child.stderr.readableLength).toBe(0); await editor.dispose();
  });
  it('stops processing buffered results when a callback disposes the editor', async () => {
    const { editor, child } = setup(); let disposal: Promise<void> | undefined;
    const active = editor.edit(request, { onProgress: () => { disposal = editor.dispose(); } });
    const caught = expect(active).rejects.toMatchObject({ code: 'CANCELLED' }); await tick();
    child.reply(2, 'progress', { event: { type: 'progress', verb: 'edit', stage: 'editing', message: 'Editing' } });
    await caught; await disposal; expect(child.closed).toBe(true);
  });
});

describe('settlement after deadlines', () => {
  it('retains a confirmed result if cancellation acknowledgement never arrives', async () => {
    vi.useFakeTimers(); const { editor, child } = setup(); const controller = new AbortController();
    const active = editor.edit(request, { signal: controller.signal }); await vi.advanceTimersByTimeAsync(0);
    controller.abort(); await vi.advanceTimersByTimeAsync(0); child.result(2);
    await vi.advanceTimersByTimeAsync(20); expect((await active).seed).toBe(1); expect(child.closed).toBe(true); await editor.dispose();
  });
  it('rejects shutdown that never acknowledges and still closes the process', async () => {
    vi.useFakeTimers(); const { editor, child } = setup();
    child.onRequest = message => { if (message.type === 'hello') child.reply(message.id, 'ready', { workerVersion: 'test', models: [] }); };
    await expect(editor.edit(request)).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
    const disposal = editor.dispose(); const caught = expect(disposal).rejects.toMatchObject({ code: 'TIMEOUT' });
    await vi.advanceTimersByTimeAsync(20); await caught; expect(child.closed).toBe(true);
  });
  it('rejects truncated frames when stdout ends', async () => {
    const { editor, child } = setup(); const active = editor.edit(request);
    const caught = expect(active).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' }); await tick();
    child.stdout.end('{"version":1'); await caught; expect(child.closed).toBe(true); await editor.dispose();
  });
  it('reports failed termination and prevents reuse', async () => {
    vi.useFakeTimers(); const { editor, child, spawn } = setup();
    child.kill = () => true;
    const active = editor.edit(request); const caught = expect(active).rejects.toMatchObject({ code: 'TERMINATION_FAILED' });
    await vi.advanceTimersByTimeAsync(120); await caught;
    await expect(editor.dispose()).rejects.toMatchObject({ code: 'TERMINATION_FAILED' });
    await expect(editor.edit(request)).rejects.toMatchObject({ code: 'DISPOSED' }); expect(spawn).toHaveBeenCalledOnce();
    child.close();
  });
});

describe('termination signal races', () => {
  it('waits for close after the OS rejects a signal to an exiting worker', async () => {
    vi.useFakeTimers(); const { editor, child } = setup();
    child.kill = () => { throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' }); };
    let settled = false;
    const active = editor.edit(request);
    void active.catch(() => { settled = true; });
    const caught = expect(active).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' });
    await vi.advanceTimersByTimeAsync(0);
    child.stdout.end();
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(false);
    child.close(); await caught; await editor.dispose();
  });
  it('retains the signal failure as a cause if closure never arrives', async () => {
    vi.useFakeTimers(); const { editor, child } = setup();
    child.kill = () => { throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' }); };
    const active = editor.edit(request);
    const caught = expect(active).rejects.toMatchObject({ code: 'TERMINATION_FAILED', cause: { code: 'TERMINATION_FAILED', cause: { code: 'EPERM' } } });
    await vi.advanceTimersByTimeAsync(120); await caught;
    await expect(editor.dispose()).rejects.toMatchObject({ code: 'TERMINATION_FAILED' });
    child.close();
  });
});

it('uses a prepared model registration across edits without reading its component files', async () => {
  const { child, worker } = setup();
  const registered = new ProcessEditor(worker, {
    adapter: 'mflux-flux2-klein-4b', directory: '/does-not-exist/picpatch-model',
    manifest: { version: 1, model: 'test', source: { repository: 'local', revision: 'a'.repeat(40) },
      components: [{ path: 'weights.safetensors', role: 'weights', bytes: 1, sha256: 'a'.repeat(64) }] },
  });
  const base = child.onRequest;
  child.onRequest = message => { base(message); if (message.type === 'edit') child.result(message.id); };
  try {
    await expect(registered.edit({ ...request, model: 'other' })).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
    await expect(registered.edit(request)).resolves.toMatchObject({ model: 'test' });
    await expect(registered.edit(request)).resolves.toMatchObject({ model: 'test' });
    expect(child.requests.filter(message => message.type === 'edit')).toHaveLength(2);
  } finally { await registered.dispose(); }
});

it('allows cancellation from progress without turning it into a callback failure', async () => {
  const { editor, child } = setup(); const controller = new AbortController();
  const base = child.onRequest;
  child.onRequest = message => {
    base(message);
    if (message.type === 'edit') child.reply(message.id, 'progress', { event: { type: 'progress', verb: 'edit', stage: 'editing', message: 'Editing' } });
    if (message.type === 'cancel') {
      child.reply(message.id, 'cancelAck', { targetId: message.targetId, accepted: true });
      child.reply(message.targetId, 'error', { error: { code: 'CANCELLED', message: 'Cancelled' } });
    }
  };
  await expect(editor.edit(request, { signal: controller.signal, onProgress: () => controller.abort() })).rejects.toMatchObject({ code: 'CANCELLED' });
  expect(child.signals).toEqual([]);
  await editor.dispose();
});
it('preserves structured worker failure causes on the public runtime error', async () => {
  const { editor, child } = setup();
  const diagnostic = { phase: 'loading', reason: 'missing-package', causes: [{ kind: 'BackendUnavailable' }, { kind: 'ModuleNotFoundError' }] };
  const active = editor.edit(request); const caught = expect(active).rejects.toMatchObject({ code: 'BACKEND_UNAVAILABLE', diagnostic });
  await tick(); child.reply(2, 'error', { error: { code: 'BACKEND_UNAVAILABLE', message: 'Unavailable', diagnostic } });
  await caught; await editor.dispose();
});

it('cancels capability discovery before image preparation and closes the worker', async () => {
  const { ImageEditor } = await import('../../src/execution/session.ts');
  const { child, editor: backend } = setup();
  child.onRequest = () => {};
  const editor = new ImageEditor(backend);
  const controller = new AbortController();
  const editing = editor.edit(request, { signal: controller.signal });
  const rejected = expect(editing).rejects.toMatchObject({ code: 'CANCELLED' });
  await tick();
  controller.abort();
  await rejected;
  await editor.dispose();
  expect(child.closed).toBe(true);
  expect(child.requests.map(message => message.type)).toEqual(['hello']);
});
