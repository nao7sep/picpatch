import { spawn } from 'node:child_process';
import { PicPatchSdkError } from '../../errors.ts';
import { processDiagnostics } from '../../process-diagnostics.ts';
import { checkSignal } from '../../operations.ts';
import { ownedSpawn, signalOwned } from '../../platform.ts';

/** Own the installer process group (on Windows, its process tree) until closure. Never expose package-manager output to caller streams. */
export function runCommand(executable: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, signal: AbortSignal, timeoutMs: number): Promise<string> {
  checkSignal(signal);
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], ...ownedSpawn });
    let output = ''; let failure: Error | undefined; let closed = false;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    let termination: ReturnType<typeof setTimeout> | undefined;
    const kill = (value: NodeJS.Signals) => {
      if (!child.pid) return;
      try { signalOwned(child.pid, value); }
      catch (cause) { if (!['ESRCH', 'EPERM'].includes((cause as NodeJS.ErrnoException).code ?? '')) failure = new PicPatchSdkError('TERMINATION_FAILED', 'Could not signal the engine process.', { cause }); }
    };
    const stop = (reason: Error) => {
      if (closed || escalation) return;
      failure ??= reason;
      kill('SIGTERM');
      escalation = setTimeout(() => {
        kill('SIGKILL');
        termination = setTimeout(() => {
          cleanup();
          reject(new PicPatchSdkError('TERMINATION_FAILED', 'Engine process closure could not be confirmed.', { cause: failure }));
        }, 2_000);
      }, 2_000);
    };
    const abort = () => stop(new PicPatchSdkError('CANCELLED', 'The operation was cancelled.'));
    const timer = setTimeout(() => stop(new PicPatchSdkError('TIMEOUT', 'Engine process timed out.')), timeoutMs);
    const cleanup = () => { clearTimeout(timer); clearTimeout(escalation); clearTimeout(termination); signal.removeEventListener('abort', abort); };
    signal.addEventListener('abort', abort, { once: true });
    child.once('error', cause => { failure ??= new PicPatchSdkError('ENGINE_UNAVAILABLE', 'Could not start the engine tool.', { cause }); });
    child.stdout.on('data', (bytes: Buffer) => { if (output.length < 65536) output += bytes.toString('utf8').slice(0, 65536 - output.length); });
    const errors = processDiagnostics(child.stderr, cause => stop(new PicPatchSdkError('ENGINE_UNAVAILABLE', 'Engine diagnostic capture failed.', { cause })));
    child.stdout.on('error', cause => stop(new PicPatchSdkError('ENGINE_UNAVAILABLE', 'Engine output pipe failed.', { cause })));
    child.stderr.on('error', cause => stop(new PicPatchSdkError('ENGINE_UNAVAILABLE', 'Engine diagnostic pipe failed.', { cause })));
    child.once('close', (code, exitSignal) => {
      closed = true; cleanup();
      void (async () => {
        try {
          const errorOutput = await errors.finish(!failure && code !== 0);
          if (!failure && code !== 0) {
            // Tool diagnostics contain only installation facts: no caller credentials/environment are passed.
            const error = new PicPatchSdkError('INSTALL_FAILED', 'The engine tool exited unsuccessfully.');
            error.details.diagnostic = { phase: 'worker', causes: [{ kind: 'ProcessExit' }], ...(code !== null ? { exitCode: code } : {}), ...(exitSignal ? { signal: exitSignal } : {}), ...(errorOutput ? { output: errorOutput } : {}) };
            failure = error;
          }
        } catch (cause) { failure = new PicPatchSdkError('ENGINE_UNAVAILABLE', 'Engine diagnostic capture or cleanup failed.', { cause: failure ? new AggregateError([failure, cause], 'Process failure and diagnostic storage failure.', { cause }) : cause }); }
        if (!failure) { resolve(output); return; }
        // uv may close its pipes before a compiler child stops. Settle the whole owned group
        // before the installer is allowed to delete its private environment.
        kill('SIGKILL');
        await confirmGroupStopped(child.pid);
        reject(failure);
      })().catch(cause => reject(new PicPatchSdkError('TERMINATION_FAILED', 'Engine subprocess group termination could not be confirmed.', { cause: new AggregateError([failure, cause]) })));
    });
    if (signal.aborted) abort();
  });
}

async function confirmGroupStopped(pid: number | undefined): Promise<void> {
  // Windows has no process groups to probe; the closed child's tree was ended with taskkill /T /F.
  if (!pid || process.platform === 'win32') return;
  const deadline = performance.now() + 2_000;
  for (;;) {
    try { process.kill(-pid, 0); }
    catch (cause) {
      const code = (cause as NodeJS.ErrnoException).code;
      if (code === 'ESRCH') return;
      // A group being reaped can briefly report EPERM after SIGKILL. It is not
      // termination evidence: keep checking within the same bound for ESRCH.
      if (code !== 'EPERM') throw cause;
    }
    if (performance.now() >= deadline) throw new Error('An engine subprocess still exists.');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
