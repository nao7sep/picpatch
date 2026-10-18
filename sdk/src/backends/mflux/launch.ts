import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WorkerLaunch } from '../../worker/process.ts';
export function workerLaunch(pythonExecutable: string, installation?: string): WorkerLaunch {
  return {
    executable: pythonExecutable,
    args: ['-E', '-s', '-B', '-u', '-m', 'picpatch_worker', '--protocol-dir', fileURLToPath(new URL('../../../protocol/', import.meta.url))],
    env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'en_US.UTF-8', HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', HF_HUB_DISABLE_TELEMETRY: '1',
      ...(installation ? { HOME: join(installation, 'home'), TMPDIR: join(installation, 'tmp'), HF_HOME: join(installation, 'home', 'huggingface') } : {}) },
    cwd: fileURLToPath(new URL('../../../runtimes/mflux/src/', import.meta.url)),
  };
}
