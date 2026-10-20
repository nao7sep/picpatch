import { listModels, openModel, inspectEngine, inspectNativeEngine, type CallOptions } from 'picpatchsdk';
import type { Settings } from './settings.ts';
export type ModelState = 'ready' | 'missing' | 'engineMissing';
/** Cheap presence evidence only: no imports, weight loading, hashing or downloads. */
export async function modelReadiness(settings: Settings, call: Pick<CallOptions, 'signal' | 'onEvent'> = {}): Promise<Record<string, ModelState>> {
  // Models without a build for this computer are neither listed nor inspected.
  const models = listModels().filter(model => model.supported), engines = new Map<string, Promise<boolean>>();
  function engine(model: typeof models[number]) {
    let pending = engines.get(model.runtime.name);
    if (!pending) {
      // The catalog says which engine prepares each model; the SDK inspects a configured native executable itself.
      pending = model.runtime.engine === 'native'
        ? inspectNativeEngine({ profile: settings.profile, ...call }).then(result => result.status === 'ready')
        : inspectEngine({ profile: settings.profile, runtime: model.runtime.name, ...call }).then(result => result.status === 'ready');
      engines.set(model.runtime.name, pending);
    }
    return pending;
  }
  const states: Record<string, ModelState> = {};
  for (const model of models) {
    if (model.acquisition !== 'pinned' && !settings.registrations[model.id]) { states[model.id] = 'missing'; continue; }
    const opened = await openModel(settings.registrations[model.id] ?? model.id, { profile: settings.profile, ...call });
    states[model.id] = opened.status !== 'completed' ? 'missing' : await engine(model) ? 'ready' : 'engineMissing';
  }
  return states;
}
