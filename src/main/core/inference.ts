import packageInfo from '../../../package.json' with { type: 'json' };
import { join } from 'node:path';
import { createImageClient, openModel, listModels, inspectNativeEngine, PicPatchSdkError } from 'picpatchsdk';
import type { EditInput, ReferenceGroup, ImageClient, ImageOutcome } from 'picpatchsdk';

/** The SDK calls inference makes; tests substitute them. */
export interface InferenceSdk { createImageClient: typeof createImageClient; openModel: typeof openModel; listModels: typeof listModels; inspectNativeEngine: typeof inspectNativeEngine }
import { commandGeometry } from '../../shared/image-command.ts';
import type { Settings } from './settings.ts';
import type { Runner } from './queue.ts';
import type { Sessions } from './sessions.ts';

/**
 * All image generation, validation and publication belong to the public SDK.
 * Each queue slot runs on its own image client. A finished client stays warm for the next run of the same model and
 * resources, so its worker process and imports start once; clients never outnumber the concurrency limit, any failure
 * or cancellation closes the client it used, and the queue releases the warm ones when it goes idle.
 */
export function inference(current: () => Sessions, settings: () => Settings, sdk: InferenceSdk = { createImageClient, openModel, listModels, inspectNativeEngine }): Runner {
  const warm: { key: string; editor: ImageClient }[] = [];
  let busy = 0;
  const release = async () => { await Promise.all(warm.splice(0).map(client => client.editor.dispose())); };
  const evictBeyond = async (limit: number) => { while (warm.length && warm.length + busy > limit) await warm.shift()!.editor.dispose(); };
  const runner: Runner = async (sessionId, run, events) => {
    const { onTeardownError, ...callOptions } = events;
    const sessions = current();
    const config = settings();
    const selected = sdk.listModels().find(model => model.id === run.modelId);
    if (!selected) throw new PicPatchSdkError('INVALID_REQUEST', 'Choose an available model.');
    // The SDK's refusal (an incomplete or newer registration) is the run's outcome, as its code says.
    const opened = await sdk.openModel(config.registrations[run.modelId] ?? run.modelId, { profile: config.profile }, { signal: events.signal, onEvent: events.onEvent });
    if (opened.status === 'refused') return { outcome: opened };
    let nativeExecutable: string | undefined;
    if (selected.runtime.engine === 'native') {
      // The SDK inspects the configured executable, or the managed one when none is configured.
      const native = await sdk.inspectNativeEngine({ profile: config.profile }, { signal: events.signal, onEvent: events.onEvent });
      if (native.status !== 'ready') throw new PicPatchSdkError(native.status === 'missing' ? 'ENGINE_MISSING' : native.status === 'unsupported' ? 'UNSUPPORTED_CAPABILITY' : 'ENGINE_INCOMPATIBLE', native.message);
      nativeExecutable = native.nativeExecutable;
    }
    const key = JSON.stringify([run.modelId, opened.model, config.profile, nativeExecutable ?? null]);
    const limit = Math.max(1, config.concurrency ?? 1);
    const index = warm.findIndex(client => client.key === key);
    let editor: ImageClient;
    if (index >= 0) editor = warm.splice(index, 1)[0]!.editor;
    else { await evictBeyond(limit - 1); editor = sdk.createImageClient({ model: opened.model, profile: config.profile, ...(nativeExecutable ? { nativeExecutable } : {}) }); }
    busy++;
    const draft = run.draft;
    // The session keeps the full record; Save image decides what a shared copy holds. No sidecar is written beside session outputs.
    const record = { includeInputs: true, caller: { name: 'picpatch', version: packageInfo.version } };
    let outcome: ImageOutcome;
    try {
      const geometry = commandGeometry(draft, selected.capabilities.maskMode);
      const common = { ...geometry, outputPath: join(sessions.directory(sessionId), 'outputs', `${run.id}.png`), seed: run.seed, parameters: draft.parameters, record, ...(draft.control ? { control: { ...draft.control, image: await sessions.imagePath(sessionId, draft.control.image) } } : {}) };
      if (draft.mode === 'generate') {
        if (draft.source || draft.mask || draft.references.length || draft.outpaint) throw new PicPatchSdkError('INVALID_REQUEST', 'Switch to Edit to use source images, references or masks.');
        outcome = await editor.generate({ ...common, prompt: draft.text }, callOptions);
      } else {
        const references = await Promise.all(draft.references.map(async group => ({ ...group, images: await Promise.all(group.images.map(image => sessions.imagePath(sessionId, image))) as ReferenceGroup['images'] })));
        const request: EditInput = { ...common, instruction: draft.text, ...(draft.source ? { sourceImage: await sessions.imagePath(sessionId, draft.source) } : {}), ...(references.length ? { references: references as [ReferenceGroup, ...ReferenceGroup[]] } : {}), ...(draft.mask ? { maskImage: await sessions.imagePath(sessionId, draft.mask) } : {}) };
        outcome = await editor.edit(request, callOptions);
      }
    } catch (error) {
      // A worker that failed or was cancelled is not trusted with the next run.
      busy--;
      try { await editor.dispose(); } catch (cleanupError) { onTeardownError(cleanupError); }
      throw error;
    }
    // Publication has settled. Eviction cannot replace its result or release active ownership again.
    busy--; warm.push({ key, editor });
    try { await evictBeyond(Math.max(1, settings().concurrency ?? 1)); } catch (error) { onTeardownError(error); }
    return { outcome };
  };
  runner.release = release;
  return runner;
}
