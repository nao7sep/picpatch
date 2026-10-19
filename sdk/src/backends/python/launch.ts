import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EngineRuntime } from '../../runtime/engine/types.ts';
import type { WorkerLaunch } from '../../worker/process.ts';
export function workerLaunch(pythonExecutable: string, installation?: string, runtime: EngineRuntime = 'mflux'): WorkerLaunch {
  const sources = ['common', runtime].map(name => fileURLToPath(new URL(`../../../runtimes/${name}/src/`, import.meta.url)));
  const module = ({ mflux: 'picpatch_worker', dreamo: 'picpatch_dreamo', diffusers: 'picpatch_diffusers' }[runtime]) + '.__main__';
  const entry = ['-c', `import sys; sys.path[:0]=${JSON.stringify(sources)}; from ${module} import run; raise SystemExit(run())`];
  return {
    executable: pythonExecutable,
    args: ['-I', '-B', '-u', ...entry, '--protocol-dir', fileURLToPath(new URL('../../../protocol/', import.meta.url))],
    env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'en_US.UTF-8', HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', HF_HUB_DISABLE_TELEMETRY: '1',
      ...(installation ? { HOME: join(installation, 'home'), TMPDIR: join(installation, 'tmp'), HF_HOME: join(installation, 'home', 'huggingface') } : {}) },
    cwd: fileURLToPath(new URL(`../../../runtimes/${runtime}/src/`, import.meta.url)),
  };
}
