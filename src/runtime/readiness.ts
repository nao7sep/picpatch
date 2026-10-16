import { withDiagnostics } from '../diagnostics.ts';
import type { DiagnosticOptions } from '../diagnostics.ts';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { LocalEditingModel, ModelCapabilities } from '../contracts.generated.ts';
import { validateLocalEditingModel, verifyModel } from '../models/verification.ts';
import { absolutePath, checkSignal, emitProgress, timeBudget, validateOperation, withDeadline } from '../operations.ts';
import { PicPatchRuntimeError, PicPatchUsageError } from '../errors.ts';
import { WorkerProcess } from '../worker/process.ts';
import type { RuntimeCheck } from '../worker/protocol.ts';
import { workerLaunch, workerTimeouts } from '../worker/launch.ts';

export interface ReadinessOptions extends DiagnosticOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  verify?: boolean;
  /** Loads existing weights without inference, then releases the process. May consume substantial memory. */
  load?: boolean;
  onProgress?: (event: { type: 'progress'; verb: 'inspectReadiness'; stage: 'files' | 'runtime'; message: string }) => void;
}
export interface ModelReadiness {
  files: 'present' | 'incomplete';
  integrity: 'not-verified' | 'matches-manifest' | 'invalid';
  runtime: RuntimeCheck | { status: 'not-checked' };
  capabilities: ModelCapabilities[];
}

/** Presence, integrity, imports and load evidence remain separate. Never downloads. */
async function inspectReadinessOperation(pythonExecutable: string, input: LocalEditingModel, options: ReadinessOptions = {}): Promise<ModelReadiness> {
  absolutePath(pythonExecutable); validateOperation(options, ['timeoutMs', 'verify', 'load']);
  for (const value of [options.verify, options.load]) if (value !== undefined && typeof value !== 'boolean') throw new PicPatchUsageError('INVALID_REQUEST', 'Readiness switches must be booleans.');
  const model = validateLocalEditingModel(input);
  const budget = timeBudget(options.timeoutMs, options.load || options.verify ? 600_000 : 30_000);
  return withDeadline(options.signal, budget, 'Model readiness inspection timed out.', async signal => {
    const operation = { ...options, signal };
    emitProgress(operation, { type: 'progress', verb: 'inspectReadiness', stage: 'files', message: 'Checking local model files.' });
    let files: ModelReadiness['files'] = 'present';
    for (const component of model.manifest.components) {
      checkSignal(signal);
      try {
        const info = await stat(join(model.directory, component.path));
        if (!info.isFile() || info.size !== component.bytes) files = 'incomplete';
      } catch (cause) {
        if (['ENOENT', 'ENOTDIR'].includes((cause as NodeJS.ErrnoException).code ?? '')) files = 'incomplete';
        else throw new PicPatchRuntimeError('MODEL_IO', 'Could not check local model files.', { cause });
      }
    }
    checkSignal(signal);
    let integrity: ModelReadiness['integrity'] = 'not-verified';
    if (options.verify && files === 'present') integrity = (await verifyModel(model.directory, model.manifest, { signal, timeoutMs: budget })).status;
    if (options.verify && files === 'incomplete') integrity = 'invalid';
    if (files === 'incomplete' || integrity === 'invalid') return { files, integrity, runtime: { status: 'not-checked' }, capabilities: [] };
    emitProgress(operation, { type: 'progress', verb: 'inspectReadiness', stage: 'runtime', message: options.load ? 'Loading the local model for a readiness check.' : 'Checking inference runtime imports.' });
    const worker = new WorkerProcess({ ...workerLaunch(pythonExecutable), model, runtimeCheck: options.load ? 'load' : 'imports' }, { ...workerTimeouts, startupMs: budget });
    const abort = () => worker.abortStartup();
    signal.addEventListener('abort', abort, { once: true });
    try {
      checkSignal(signal);
      const ready = await worker.start();
      checkSignal(signal);
      if (ready.type !== 'ready' || !ready.runtimeCheck) throw new PicPatchRuntimeError('PROTOCOL_ERROR', 'Worker did not report inference readiness.');
      return { files, integrity, runtime: ready.runtimeCheck, capabilities: ready.models };
    } finally {
      try { await worker.dispose(); }
      finally { signal.removeEventListener('abort', abort); }
    }
  });
}

export function inspectReadiness(pythonExecutable: string, input: LocalEditingModel, options: ReadinessOptions = {}): Promise<ModelReadiness> {
  return withDiagnostics('inspectReadiness', options, operation => inspectReadinessOperation(pythonExecutable, input, operation));
}
