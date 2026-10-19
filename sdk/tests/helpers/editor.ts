import { ImageClientImpl } from '../../src/execution/session.ts';
import { ProcessEditor } from '../../src/execution/worker-backend.ts';
import { WorkerProcess, workerTimeouts } from '../../src/worker/process.ts';
import { workerLaunch } from '../../src/backends/python/launch.ts';
import type { ImageClientOptions } from '../../src/client.ts';
/** Internal tests can provoke missing dependencies without exposing a second installation API. */
export function fixtureEditor(options: Omit<ImageClientOptions, 'engineDirectory'> & { pythonExecutable: string }) {
  return new ImageClientImpl(new ProcessEditor(new WorkerProcess({ ...workerLaunch(options.pythonExecutable), ...(options.model ? { model: options.model } : {}) }, workerTimeouts), options.model), options.defaults, options.model?.manifest.model);
}
