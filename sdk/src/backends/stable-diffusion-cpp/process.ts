import { spawn } from 'node:child_process';
import { PicPatchSdkError } from '../../errors.ts';
import { checkSignal } from '../../operations.ts';
import { ownedSpawn, signalOwned, toolEnvironment } from '../../platform.ts';
import type { WorkerTimeouts } from '../../worker/process.ts';

/** One short-lived native process, with ownership through pipe closure and termination. */
export class NativeProcess {
  private readonly lifetime = new AbortController();
  private active: Promise<string> | undefined;
  private poisoned: Error | undefined;
  constructor(executable: string, timeouts: WorkerTimeouts) { this.executable = executable; this.timeouts = timeouts; }
  private readonly executable: string;
  private readonly timeouts: WorkerTimeouts;

  run(args: string[], cwd: string, timeout: number, signal?: AbortSignal, capture = false): Promise<string> {
    if (this.lifetime.signal.aborted) return Promise.reject(new PicPatchSdkError('DISPOSED', 'Native runtime is disposed.'));
    if (this.poisoned) return Promise.reject(this.poisoned);
    if (this.active) return Promise.reject(new PicPatchSdkError('INTERNAL', 'Native runtime is busy.'));
    const combined = AbortSignal.any([this.lifetime.signal, ...(signal ? [signal] : [])]);
    this.active = Promise.resolve().then(() => {
      checkSignal(combined);
      return new Promise<string>((resolve, reject) => {
        const child = spawn(this.executable, args, { cwd, env: toolEnvironment(), stdio: ['ignore', 'pipe', 'pipe'], ...ownedSpawn });
        let failure: Error | undefined; let output = Buffer.alloc(0); let closed = false;
        let escalation: ReturnType<typeof setTimeout> | undefined;
        let termination: ReturnType<typeof setTimeout> | undefined;
        const kill = (signal: NodeJS.Signals) => {
          if (closed || child.pid === undefined) return;
          try { signalOwned(child.pid, signal); }
          catch (cause) { if ((cause as NodeJS.ErrnoException).code !== 'ESRCH') failure ??= new PicPatchSdkError('TERMINATION_FAILED', 'Could not signal the native runtime.', { cause }); }
        };
        const stop = (reason: Error) => {
          if (closed || escalation !== undefined) return;
          failure ??= reason;
          kill('SIGTERM');
          escalation = setTimeout(() => {
            kill('SIGKILL');
            termination = setTimeout(() => {
              this.poisoned = new PicPatchSdkError('TERMINATION_FAILED', 'Native process closure could not be confirmed.');
              reject(this.poisoned);
            }, this.timeouts.terminationMs);
          }, this.timeouts.cancellationMs);
        };
        const abort = () => stop(new PicPatchSdkError('CANCELLED', 'The operation was cancelled.'));
        const deadline = setTimeout(() => stop(new PicPatchSdkError('TIMEOUT', 'Native runtime exceeded its time budget.')), timeout);
        combined.addEventListener('abort', abort, { once: true });
        child.once('error', cause => { failure ??= new PicPatchSdkError('WORKER_UNAVAILABLE', 'Could not run the native executable.', { cause }); });
        child.stdout.on('error', cause => stop(new PicPatchSdkError('WORKER_UNAVAILABLE', 'Native output pipe failed.', { cause })));
        child.stderr.on('error', cause => stop(new PicPatchSdkError('WORKER_UNAVAILABLE', 'Native diagnostic pipe failed.', { cause })));
        // Capture only bounded help/version output. Inference output may contain private text.
        child.stdout.on('data', (chunk: Buffer) => { if (capture && output.length < 8192) output = Buffer.concat([output, chunk.subarray(0, 8192 - output.length)]); });
        child.stderr.resume();
        child.once('close', (code, signal) => {
          closed = true; clearTimeout(deadline); clearTimeout(escalation); clearTimeout(termination);
          combined.removeEventListener('abort', abort);
          if (failure) reject(failure);
          else if (code !== 0) {
            const error = new PicPatchSdkError('WORKER_EXITED', 'Native runtime did not complete successfully.');
            error.details.diagnostic = { phase: 'worker', causes: [{ kind: 'ProcessExit' }], ...(code !== null ? { exitCode: code } : {}), ...(signal ? { signal } : {}) };
            reject(error);
          }
          else resolve(output.toString('utf8'));
        });
        if (combined.aborted) abort();
      });
    }).catch((cause: unknown) => {
      if (cause instanceof PicPatchSdkError) throw cause;
      throw new PicPatchSdkError('WORKER_UNAVAILABLE', 'Could not run the native executable.', { cause });
    }).finally(() => { this.active = undefined; });
    return this.active;
  }
  async dispose(): Promise<void> {
    this.lifetime.abort();
    try { await this.active; } catch (error) { if (error instanceof PicPatchSdkError && error.code === 'TERMINATION_FAILED') throw error; }
    if (this.poisoned) throw this.poisoned;
  }
}
