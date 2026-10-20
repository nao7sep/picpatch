import { emitProgress } from '../operations.ts';
import type { LocalModel } from '../contracts.generated.ts';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { ProtocolSession, type WorkerRequest, type WorkerResponse } from './protocol.ts';
import { PicPatchSdkError } from '../errors.ts';
import { ownedSpawn, signalOwned } from '../platform.ts';
import type { ProgressEvent } from '../contracts.generated.ts';

export interface WorkerLaunch {
  executable: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  model?: LocalModel;
  runtimeCheck?: 'imports' | 'load';
}
export type { WorkerTimeouts } from '../types.ts';
import type { WorkerTimeouts } from '../types.ts';
export const workerTimeouts: WorkerTimeouts = { startupMs: 30_000, editMs: 1_800_000, generateMs: 1_800_000, cancellationMs: 5_000, shutdownMs: 5_000, terminationMs: 2_000 };
export type SpawnWorker = (launch: WorkerLaunch) => ChildProcessWithoutNullStreams;
const spawnWorker: SpawnWorker = launch => spawn(launch.executable, launch.args, {
  cwd: launch.cwd, env: launch.env ?? {}, stdio: 'pipe', ...ownedSpawn,
});
interface Pending {
  resolve: (response: WorkerResponse) => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
  onProgress?: (event: ProgressEvent) => void;
  request: WorkerRequest;
}

/** Owns one process and its pipes until close, including after timeout or abort. */
export class WorkerProcess {
  private readonly protocol = new ProtocolSession();
  private readonly pending = new Map<number, Pending>();
  private child: ChildProcessWithoutNullStreams | undefined;
  private nextId = 1;
  private startup: Promise<WorkerResponse> | undefined;
  private closing = false;
  private shutdownAck = false;
  private closed = false;
  private failure: unknown;
  private terminationUnconfirmed = false;
  get restartable(): boolean { return !!this.failure && this.closed && !this.terminationUnconfirmed; }
  private stopping: Promise<void> | undefined;
  private readonly closeWait = Promise.withResolvers<void>();
  private readonly decoder = new TextDecoder('utf-8', { fatal: true });
  private remainder = '';
  private readonly launch: WorkerLaunch;
  private readonly timeouts: WorkerTimeouts;
  private readonly spawn: SpawnWorker;

  constructor(launch: WorkerLaunch, timeouts: WorkerTimeouts, spawnImpl: SpawnWorker = spawnWorker) {
    this.launch = launch; this.timeouts = timeouts; this.spawn = spawnImpl;
    void this.closeWait.promise.catch(() => {});
  }

  start(): Promise<WorkerResponse> {
    if (this.failure) return (this.stopping ?? Promise.resolve()).then(() => { throw this.failure; });
    if (this.startup) return this.startup;
    if (this.closing) return Promise.reject(new PicPatchSdkError('DISPOSED', 'Worker is closed.'));
    try {
      this.child = this.spawn(this.launch);
      this.child.once('error', cause => this.fail(new PicPatchSdkError('WORKER_UNAVAILABLE', 'Could not run the worker. Check the prepared Python interpreter and packaged worker resources.', { cause })));
      this.child.once('exit', (code, signal) => {
        if (!this.failure && !this.shutdownAck) {
          const starting = [...this.pending.values()].some(pending => pending.request.type === 'hello');
          const error = new PicPatchSdkError('WORKER_EXITED', starting ? 'Worker exited before its handshake. Check the prepared Python dependencies and packaged worker resources.' : 'Worker exited unexpectedly.');
          error.details.diagnostic = { phase: 'worker', causes: [{ kind: 'ProcessExit' }], ...(code !== null ? { exitCode: code } : {}), ...(signal ? { signal } : {}) };
          this.fail(error);
        }
      });
      this.child.once('close', (code, signal) => {
        this.closed = true;
        // Closure, not a successful signal, proves the owned worker has stopped.
        this.closeWait.resolve();
        if (!this.failure && (!this.shutdownAck || this.remainder.length || code !== 0 || signal !== null)) {
          this.fail(new PicPatchSdkError('WORKER_EXITED', 'Worker exited before completing the session.'));
        }
      });
      this.child.stdin.on('error', cause => this.fail(new PicPatchSdkError('WORKER_UNAVAILABLE', 'Worker input failed.', { cause })));
      this.child.stdout.on('error', cause => this.fail(new PicPatchSdkError('WORKER_UNAVAILABLE', 'Worker output failed.', { cause })));
      this.child.stderr.on('error', cause => this.fail(new PicPatchSdkError('WORKER_UNAVAILABLE', 'Worker diagnostics failed.', { cause })));
      // Drain diagnostics without retaining private data or writing to the caller's streams.
      this.child.stderr.resume();
      this.child.stdout.on('data', (chunk: Buffer) => this.read(chunk));
      this.child.stdout.once('end', () => {
        try {
          this.remainder += this.decoder.decode();
          // Empty EOF alone cannot distinguish a crashed process from malformed output.
          // Let exit/close report the observed exit; a stalled process retains its deadline.
          if (this.remainder.length) {
            const starting = [...this.pending.values()].some(pending => pending.request.type === 'hello');
            throw new PicPatchSdkError('PROTOCOL_ERROR', starting ? 'Worker output ended before its handshake. Check the prepared Python dependencies and packaged worker resources.' : 'Worker output ended unexpectedly.');
          }
        } catch (cause) { this.fail(cause instanceof PicPatchSdkError ? cause : new PicPatchSdkError('PROTOCOL_ERROR', 'Invalid worker output.', { cause })); }
      });
      this.startup = this.request({ version: 1, id: this.nextId++, type: 'hello', ...(this.launch.model ? { model: this.launch.model } : {}), ...(this.launch.runtimeCheck ? { runtimeCheck: this.launch.runtimeCheck } : {}) }, this.timeouts.startupMs);
    } catch (cause) {
      this.closed = true;
      this.closeWait.resolve();
      this.failure = new PicPatchSdkError('WORKER_UNAVAILABLE', 'Could not start the worker.', { cause });
      this.startup = Promise.reject(this.failure);
    }
    return this.startup;
  }

  private read(chunk: Buffer): void {
    if (this.failure) return;
    try {
      this.remainder += this.decoder.decode(chunk, { stream: true });
      let newline: number;
      while (!this.failure && (newline = this.remainder.indexOf('\n')) !== -1) {
        const line = this.remainder.slice(0, newline);
        this.remainder = this.remainder.slice(newline + 1);
        const response = this.protocol.receive(line);
        const pending = this.pending.get(response.id)!;
        if (response.type === 'progress' || response.type === 'event') {
          pending.onProgress?.(response.event);
        } else {
          if (pending.request.type === 'hello' && response.type !== 'ready') throw new PicPatchSdkError('PROTOCOL_ERROR', 'Worker rejected its startup handshake.');
          if (response.type === 'result' && (pending.request.type === 'edit' || pending.request.type === 'generate')) {
            const expected = pending.request.request;
            const result = response.result;
            const references = 'instruction' in expected ? expected.references ?? [] : [];
            if (result.model !== expected.model || result.image.path !== expected.outputPath ||
                (expected.seed !== undefined && result.seed !== expected.seed) ||
                result.references.length !== references.length ||
                result.references.some((group, index) => {
                  const wanted = references[index];
                  return !wanted || group.id !== wanted.id || group.role !== wanted.role ||
                    group.images.length !== wanted.images.length || group.images.some((image, i) => image !== wanted.images[i]);
                })) {
              throw new PicPatchSdkError('PROTOCOL_ERROR', 'Worker result does not describe the requested operation.');
            }
          }
          if (response.type === 'shutdownAck') this.shutdownAck = true;
          clearTimeout(pending.timer);
          this.pending.delete(response.id);
          pending.resolve(response);
        }
      }
    } catch (cause) {
      this.fail(cause instanceof PicPatchSdkError ? cause : new PicPatchSdkError('PROTOCOL_ERROR', 'Invalid worker output.', { cause }));
    }
  }

  private request(request: WorkerRequest, timeout: number, onProgress?: (event: ProgressEvent) => void, timeoutError?: Error): Promise<WorkerResponse> {
    if (this.failure) return Promise.reject(this.failure);
    const deferred = Promise.withResolvers<WorkerResponse>();
    try {
      const frame = this.protocol.send(request);
      const timer = setTimeout(() => this.fail(timeoutError ?? new PicPatchSdkError('TIMEOUT', `Worker ${request.type} timed out.`)), timeout);
      this.pending.set(request.id, { ...deferred, timer, request, ...(onProgress ? { onProgress } : {}) });
      this.child!.stdin.write(frame, error => { if (error) this.fail(new PicPatchSdkError('WORKER_UNAVAILABLE', 'Could not send a worker request.', { cause: error })); });
    } catch (error) {
      if (this.pending.has(request.id)) this.fail(error);
      else deferred.reject(error);
    }
    return deferred.promise;
  }

  async edit(request: Extract<WorkerRequest, { type: 'edit' }>['request'], onProgress?: (event: ProgressEvent) => void, signal?: AbortSignal): Promise<WorkerResponse> {
    return this.execute({ version: 1, id: this.nextId++, type: 'edit', request }, onProgress, signal);
  }

  generate(request: Extract<WorkerRequest, { type: 'generate' }>['request'], onProgress?: (event: ProgressEvent) => void, signal?: AbortSignal): Promise<WorkerResponse> {
    return this.execute({ version: 1, id: this.nextId++, type: 'generate', request }, onProgress, signal);
  }

  private async execute(request: Extract<WorkerRequest, { type: 'edit' | 'generate' }>, onProgress?: (event: ProgressEvent) => void, signal?: AbortSignal): Promise<WorkerResponse> {
    const id = request.id;
    const timeout = request.type === 'generate' ? this.timeouts.generateMs ?? this.timeouts.editMs : this.timeouts.editMs;
    const result = this.request(request, timeout, onProgress);
    let cancellation: Promise<WorkerResponse> | undefined;
    let cancellationTimer: ReturnType<typeof setTimeout> | undefined;
    const abort = () => {
      if (cancellation || !this.pending.has(id)) return;
      cancellation = this.request({ version: 1, id: this.nextId++, type: 'cancel', targetId: id }, this.timeouts.cancellationMs, undefined, new PicPatchSdkError('CANCELLED', 'The operation was cancelled.'));
      // The acknowledgement alone does not settle the edit or release the worker.
      cancellationTimer = setTimeout(() => this.fail(new PicPatchSdkError('CANCELLED', 'The operation was cancelled.')), this.timeouts.cancellationMs);
      void cancellation.catch(() => {});
    };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    try {
      const response = await result;
      if (cancellation) {
        try { await cancellation; }
        catch (error) {
          // A confirmed output remains a success after the transport is stopped.
          if (response.type !== 'result' || (error instanceof PicPatchSdkError && error.code === 'TERMINATION_FAILED')) throw error;
        }
      }
      return response;
    } finally {
      signal?.removeEventListener('abort', abort);
      clearTimeout(cancellationTimer);
    }
  }

  abortStartup(): void { this.fail(new PicPatchSdkError('CANCELLED', 'The operation was cancelled.')); }

  private fail(error: unknown): void {
    if (this.failure) return;
    this.failure = error;
    for (const pending of this.pending.values()) clearTimeout(pending.timer);
    void this.stop().then(() => this.rejectPending(error), terminationError => this.rejectPending(terminationError));
  }
  private rejectPending(error: unknown): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  private signal(signal: NodeJS.Signals): void {
    if (!this.child) return;
    try {
      // A POSIX group may outlive the closed child; a Windows tree is ended while the child still runs.
      if (this.child.pid && (process.platform !== 'win32' || !this.closed)) signalOwned(this.child.pid, signal);
      else if (!this.closed) this.child.kill(signal);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ESRCH') throw new PicPatchSdkError('TERMINATION_FAILED', 'Could not terminate the worker.', { cause });
    }
  }

  private stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.stopping = (async () => {
      if (!this.child || this.closed) return;
      let signalError: unknown;
      // An exiting process can reject a signal before Node reports its close event.
      // Keep ownership until close or the termination deadline, even if signalling fails.
      try { this.signal('SIGTERM'); } catch (error) { signalError = error; }
      let forceTimer: ReturnType<typeof setTimeout> | undefined;
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([this.closeWait.promise, new Promise<never>((_, reject) => {
          forceTimer = setTimeout(() => { try { this.signal('SIGKILL'); } catch (error) { signalError = error; } }, this.timeouts.terminationMs);
          deadline = setTimeout(() => reject(new PicPatchSdkError('TERMINATION_FAILED', 'Worker termination could not be confirmed.', signalError ? { cause: signalError } : undefined)), this.timeouts.terminationMs * 2);
        })]);
      } catch (error) { this.terminationUnconfirmed = true; throw error; }
      finally { clearTimeout(forceTimer); clearTimeout(deadline); }
    })();
    return this.stopping;
  }

  async dispose(): Promise<void> {
    this.closing = true;
    if (!this.child) return;
    if (this.failure) { await this.stop(); return; }
    if (this.pending.size) {
      this.fail(new PicPatchSdkError('CANCELLED', 'Image client was disposed.'));
      await this.stop();
      return;
    }
    const response = await this.request({ version: 1, id: this.nextId++, type: 'shutdown' }, this.timeouts.shutdownMs);
    if (response.type !== 'shutdownAck') { this.fail(new PicPatchSdkError('PROTOCOL_ERROR', 'Worker rejected shutdown.')); await this.stop(); throw this.failure; }
    this.child.stdin.end();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([this.closeWait.promise, new Promise<void>(resolve => {
        timer = setTimeout(() => { this.fail(new PicPatchSdkError('TIMEOUT', 'Worker did not exit after shutdown.')); resolve(); }, this.timeouts.shutdownMs);
      })]);
      if (this.failure) { await this.stop(); throw this.failure; }
    } finally { clearTimeout(timer); }
  }
}
