import { runtimePaths } from './engine/identity.ts';
import { withDiagnostics } from '../diagnostics.ts';
import { WorkerProcess } from '../worker/process.ts';
import { workerLaunch } from '../backends/python/launch.ts';
import { workerTimeouts } from '../worker/process.ts';
import { absolutePath, checkSignal, emitProgress, timeBudget, validateOperation, withSettings } from '../operations.ts';
import { PicPatchSdkError } from '../errors.ts';
import type { RuntimeInspection, RuntimeOperationOptions, RuntimeSettings } from './types.ts';
import type { CallOptions } from '../types.ts';

/** Starts only the bundled model-free handshake and confirms closure before returning. */
async function inspectRuntimeOperation(pythonExecutable: string, options: RuntimeOperationOptions = {}): Promise<RuntimeInspection> {
  absolutePath(pythonExecutable); validateOperation(options, ['timeoutMs', 'runtime']);
  runtimePaths(options.runtime);
  const budget = timeBudget(options.timeoutMs, 30_000); const operation = { ...options };
  emitProgress(operation, { type: 'progress', verb: 'inspectRuntime', stage: 'checking', message: 'Checking the worker environment.' });
  const worker = new WorkerProcess(workerLaunch(pythonExecutable, undefined, options.runtime), { ...workerTimeouts, startupMs: budget });
  const abort = () => worker.abortStartup();
  operation.signal?.addEventListener('abort', abort, { once: true });
  let result: RuntimeInspection;
  try {
    checkSignal(operation.signal);
    const ready = await worker.start();
    checkSignal(operation.signal);
    if (ready.type !== 'ready') throw new PicPatchSdkError('PROTOCOL_ERROR', 'Worker did not complete its handshake.');
    result = { pythonExecutable, status: 'worker-ready', workerVersion: ready.workerVersion, models: ready.models };
  } finally {
    try { await worker.dispose(); }
    finally { operation.signal?.removeEventListener('abort', abort); }
  }
  checkSignal(operation.signal);
  return result;
}

export function inspectRuntime(pythonExecutable: string, settings: RuntimeSettings = {}, options: CallOptions = {}): Promise<RuntimeInspection> {
  return withDiagnostics('inspectRuntime', options, call => inspectRuntimeOperation(pythonExecutable, withSettings(settings, ['runtime'], call)));
}
