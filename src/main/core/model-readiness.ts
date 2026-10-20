import { access, constants } from 'node:fs/promises';
import { listModels, openModel, inspectEngine, inspectNativeEngine } from 'picpatchsdk';
import { pythonRuntime } from './engines.ts';
import type { Settings } from './settings.ts';
export type ModelState = 'ready' | 'missing' | 'engineMissing';
/** Cheap presence evidence only: no imports, weight loading, hashing or downloads. */
export async function modelReadiness(settings: Settings): Promise<Record<string, ModelState>> {
  // Models without a build for this computer are neither listed nor inspected.
  const models = listModels().filter(model => model.supported), engines = new Map<string, Promise<boolean>>();
  function engine(model: typeof models[number]) {
    const runtime = model.runtime.name;
    let pending = engines.get(runtime);
    if (!pending) {
      pending = runtime === 'stable-diffusion.cpp'
        ? settings.profile.nativeExecutable ? access(settings.profile.nativeExecutable, constants.X_OK).then(() => true, () => false) : inspectNativeEngine({ profile: settings.profile }).then(result => result.status === 'ready')
        : inspectEngine({ profile: settings.profile, runtime: pythonRuntime(models, model.id) }).then(result => result.status === 'ready');
      engines.set(runtime, pending);
    }
    return pending;
  }
  const states: Record<string, ModelState> = {};
  for (const model of models) {
    if (model.acquisition !== 'pinned' && !settings.registrations[model.id]) { states[model.id] = 'missing'; continue; }
    const opened = await openModel(settings.registrations[model.id] ?? model.id, { profile: settings.profile });
    states[model.id] = opened.status !== 'present' ? 'missing' : await engine(model) ? 'ready' : 'engineMissing';
  }
  return states;
}
