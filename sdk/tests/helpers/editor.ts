import { ImageEditor } from '../../src/execution/session.ts';
import { ProcessEditor } from '../../src/execution/worker-backend.ts';
import { WorkerProcess, workerTimeouts } from '../../src/worker/process.ts';
import { workerLaunch } from '../../src/backends/mflux/launch.ts';
import type { EditorOptions } from '../../src/client.ts';
/** Internal tests can provoke missing dependencies without exposing a second installation API. */
export function fixtureEditor(options: Omit<EditorOptions, 'engineDirectory'> & { pythonExecutable: string }) {
  return new ImageEditor(new ProcessEditor(new WorkerProcess({ ...workerLaunch(options.pythonExecutable), ...(options.model ? { model: options.model } : {}) }, workerTimeouts), options.model), options.defaults, options.model?.manifest.model);
}
