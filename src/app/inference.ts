import packageInfo from '../../package.json' with { type: 'json' };
import { join } from 'node:path';
import { createEditor, openModel, listModels, inspectNativeEngine, PicPatchSdkError } from 'picpatchsdk';
import type { EditInput, ReferenceGroup, ImageOutcome } from 'picpatchsdk';
import type { Settings } from './settings.ts';
import type { Runner } from './queue.ts';
import type { Sessions } from './sessions.ts';

/** All image generation, validation and publication belong to the public SDK. */
export function inference(sessions: Sessions, settings: () => Settings): Runner {
  return async (sessionId, run, events) => {
    const config = settings();
    const selected = listModels().find(model => model.id === run.modelId);
    if (!selected) throw new PicPatchSdkError('INVALID_REQUEST', 'Choose an available model.');
    const opened = await openModel(config.registrations[run.modelId] ?? run.modelId, { profile: config.profile, signal: events.signal, onEvent: events.onEvent });
    if (opened.status !== 'ready') throw new PicPatchSdkError('MODEL_IO', 'Prepare this model in Managed tools and models before running it.');
    let nativeExecutable = config.profile.nativeExecutable;
    if (selected.runtime.name === 'stable-diffusion.cpp' && !nativeExecutable) {
      const native = await inspectNativeEngine({ profile: config.profile, signal: events.signal, onEvent: events.onEvent });
      if (native.status !== 'ready') throw new PicPatchSdkError('ENGINE_MISSING', 'Install the native engine in Managed tools and models.');
      nativeExecutable = native.nativeExecutable;
    }
    const editor = createEditor({ model: opened.model, profile: config.profile, ...(selected.runtime.name === 'stable-diffusion.cpp' ? { nativeExecutable } : {}) });
    const draft = run.draft;
    const common = { outputPath: join(sessions.directory(sessionId), 'outputs', `${run.id}.png`), size: { width: draft.width, height: draft.height }, seed: run.seed, parameters: draft.parameters, sidecar: { includeInputs: true }, ...(draft.control ? { control: { ...draft.control, image: await sessions.imagePath(sessionId, draft.control.image) } } : {}) };
    try {
      if (draft.mode === 'generate') {
        if (draft.source || draft.mask || draft.references.length || draft.outpaint) throw new PicPatchSdkError('INVALID_REQUEST', 'Switch to Edit to use source images, references or masks.');
        return await finish(await editor.generate({ ...common, prompt: draft.text }, { ...events, caller: { name: 'picpatch', version: packageInfo.version } }));
      }
      const references = await Promise.all(draft.references.map(async group => ({ ...group, images: await Promise.all(group.images.map(image => sessions.imagePath(sessionId, image))) as ReferenceGroup['images'] })));
      const request: EditInput = { ...common, instruction: draft.text, ...(draft.source ? { sourceImage: await sessions.imagePath(sessionId, draft.source) } : {}), ...(references.length ? { references: references as [ReferenceGroup, ...ReferenceGroup[]] } : {}), ...(draft.mask ? { maskImage: await sessions.imagePath(sessionId, draft.mask) } : {}), ...(draft.outpaint ? { outpaint: { size: { width: draft.outpaint.width, height: draft.outpaint.height }, left: draft.outpaint.left, top: draft.outpaint.top } } : {}) };
      return await finish(await editor.edit(request, { ...events, caller: { name: 'picpatch', version: packageInfo.version } }));
    } catch (error) { await editor.dispose(); throw error; }
    async function finish(outcome: ImageOutcome) {
      try { await editor.dispose(); return { outcome }; }
      catch { return { outcome, stopIssue: 'The result was retained, but the worker did not close cleanly. The queue is paused.' }; }
    }
  };
}
