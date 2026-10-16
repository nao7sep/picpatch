import { WorkerProcess } from '../worker/process.ts';
import { workerLaunch, workerTimeouts } from '../worker/launch.ts';
import { absolutePath, checkSignal, emitProgress, timeBudget, validateOperation } from '../operations.ts';
import { PicPatchRuntimeError } from '../errors.ts';
import type { RuntimeInspection, RuntimeOperationOptions } from './types.ts';

/** Starts only the bundled model-free handshake and confirms closure before returning. */
export async function inspectRuntime(pythonExecutable: string, options: RuntimeOperationOptions = {}): Promise<RuntimeInspection> {
  absolutePath(pythonExecutable); validateOperation(options, ['timeoutMs']);
  const budget = timeBudget(options.timeoutMs, 30_000); const operation = { ...options };
  emitProgress(operation, { type: 'progress', verb: 'inspectRuntime', stage: 'checking', message: 'Checking the worker environment.' });
  const worker = new WorkerProcess(workerLaunch(pythonExecutable), { ...workerTimeouts, startupMs: budget });
  const abort = () => worker.abortStartup();
  operation.signal?.addEventListener('abort', abort, { once: true });
  let result: RuntimeInspection;
  try {
    checkSignal(operation.signal);
    const ready = await worker.start();
    checkSignal(operation.signal);
    if (ready.type !== 'ready') throw new PicPatchRuntimeError('PROTOCOL_ERROR', 'Worker did not complete its handshake.');
    result = { pythonExecutable, status: 'worker-ready', workerVersion: ready.workerVersion, models: ready.models };
  } finally {
    try { await worker.dispose(); }
    finally { operation.signal?.removeEventListener('abort', abort); }
  }
  checkSignal(operation.signal);
  return result;
}
