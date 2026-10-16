import { spawn } from 'node:child_process';
import { PicPatchCancelledError, PicPatchRuntimeError } from '../errors.ts';
import { checkSignal } from '../operations.ts';

/** Setup owns the installer and its pipes until actual closure, not merely a timeout. */
export async function runInstaller(executable: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number, signal?: AbortSignal): Promise<void> {
  checkSignal(signal);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, args, { cwd, env, detached: process.platform !== 'win32', stdio: 'pipe' });
    let failure: unknown; let closed = false; let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: unknown) => {
      if (settled) return; settled = true;
      clearTimeout(timer); clearTimeout(killTimer); clearTimeout(deadline);
      signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolve();
    };
    const send = (value: NodeJS.Signals) => {
      if (closed) return;
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, value);
        else child.kill(value);
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== 'ESRCH') signalFailure = cause;
      }
    };
    let signalFailure: unknown;
    const stop = (error: unknown) => {
      if (failure || closed) return;
      failure = error;
      send('SIGTERM');
      killTimer = setTimeout(() => send('SIGKILL'), 2_000);
      deadline = setTimeout(() => finish(new PicPatchRuntimeError('TERMINATION_FAILED', 'Installer termination could not be confirmed.', { cause: signalFailure ?? failure })), 4_000);
    };
    const abort = () => stop(new PicPatchCancelledError('Runtime setup was cancelled.'));
    const timer = setTimeout(() => stop(new PicPatchRuntimeError('TIMEOUT', 'Runtime setup timed out.')), timeoutMs);
    child.once('error', cause => stop(new PicPatchRuntimeError('RUNTIME_SETUP', 'Could not start the runtime installer.', { cause })));
    child.once('close', (code, exitSignal) => {
      closed = true;
      finish(failure ?? (code === 0 ? undefined : new PicPatchRuntimeError('RUNTIME_SETUP', 'Runtime installation failed. Check the selected tools and package availability.', { cause: { exitCode: code, signal: exitSignal } })));
    });
    child.stdout.on('error', cause => stop(cause)); child.stderr.on('error', cause => stop(cause));
    child.stdin.on('error', cause => stop(cause));
    child.stdout.resume(); child.stderr.resume(); child.stdin.end();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}
