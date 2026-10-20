import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PythonRuntime } from '../../runtime/engine/types.ts';
import type { WorkerLaunch } from '../../worker/process.ts';
import { toolEnvironment } from '../../platform.ts';
/** The package root, from this module's own path. Not new URL(..., import.meta.url): a bundler treats that pattern as an asset import. */
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export function workerLaunch(pythonExecutable: string, installation?: string, runtime: PythonRuntime = 'mflux'): WorkerLaunch {
  const sources = ['common', runtime].map(name => join(root, 'runtimes', name, 'src'));
  const module = ({ mflux: 'picpatch_worker', dreamo: 'picpatch_dreamo', diffusers: 'picpatch_diffusers' }[runtime]) + '.__main__';
  const entry = ['-c', `import sys; sys.path[:0]=${JSON.stringify(sources)}; from ${module} import run; raise SystemExit(run())`];
  return {
    executable: pythonExecutable,
    args: ['-I', '-B', '-u', ...entry, '--protocol-dir', join(root, 'protocol')],
    env: { ...toolEnvironment(), HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', HF_HUB_DISABLE_TELEMETRY: '1',
      ...(installation ? { HOME: join(installation, 'home'), TMPDIR: join(installation, 'tmp'), HF_HOME: join(installation, 'home', 'huggingface') } : {}) },
    cwd: join(root, 'runtimes', runtime, 'src'),
  };
}
