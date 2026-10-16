import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WorkerLaunch, WorkerTimeouts } from './process.ts';
export const workerTimeouts: WorkerTimeouts = { startupMs: 30_000, editMs: 1_800_000, cancellationMs: 5_000, shutdownMs: 5_000, terminationMs: 2_000 };
export function workerLaunch(pythonExecutable: string): WorkerLaunch {
  return {
    executable: pythonExecutable,
    args: ['-E', '-s', '-B', '-u', '-m', 'picpatch_worker', '--protocol-dir', fileURLToPath(new URL('../../protocol/', import.meta.url))],
    cwd: fileURLToPath(new URL('../../worker/src/', import.meta.url)),
  };
}

/** Standard uv project environment; resolves a path without installing or probing Python. */
export function defaultPythonExecutable(): string {
  const worker = fileURLToPath(new URL('../../worker/', import.meta.url));
  return join(resolve(worker, process.env.UV_PROJECT_ENVIRONMENT ?? '.venv'), process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
}
