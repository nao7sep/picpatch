import { listModels, openModel, inspectEngine, inspectNativeEngine, isPicPatchSdkError, type CallOptions } from 'picpatchsdk';
import { errorNotice } from '../../shared/i18n/index.ts';
import type { Settings } from './settings.ts';
import type { ModelState } from '../../shared/readiness.ts';
/** Model presence plus one dependency-import probe per engine; no weight loading, hashing or downloads. */
export async function modelReadiness(settings: Settings, call: Pick<CallOptions, 'signal' | 'onEvent'> = {}): Promise<Record<string, ModelState>> {
  call.signal?.throwIfAborted();
  // Models without a build for this computer are neither listed nor inspected.
  const models = listModels().filter(model => model.supported), engines = new Map<string, Promise<boolean>>();
  function engine(model: typeof models[number]) {
    let pending = engines.get(model.runtime.name);
    if (!pending) {
      // The catalog says which engine prepares each model; the SDK inspects a configured native executable itself.
      pending = model.runtime.engine === 'native'
        ? inspectNativeEngine({ profile: settings.profile }, call).then(result => result.status === 'ready')
        : inspectEngine({ profile: settings.profile, runtime: model.runtime.name }, call).then(result => result.status === 'ready');
      engines.set(model.runtime.name, pending);
    }
    return pending;
  }
  const states: Record<string, ModelState> = {};
  for (const model of models) {
    if (model.acquisition !== 'pinned' && !settings.registrations[model.id]) { states[model.id] = 'missing'; continue; }
    try {
      const opened = await openModel(settings.registrations[model.id] ?? model.id, { profile: settings.profile }, call);
      states[model.id] = opened.status !== 'completed' ? 'missing' : await engine(model) ? 'ready' : 'engineMissing';
    } catch (error) {
      if (call.signal?.aborted || isPicPatchSdkError(error) && error.kind === 'cancelled') throw error;
      states[model.id] = { status: 'failed', notice: errorNotice(error) };
    }
  }
  call.signal?.throwIfAborted();
  return states;
}
