import packageInfo from '../../../package.json' with { type: 'json' };
import { join } from 'node:path';
import { createImageClient, openModel, listModels, inspectNativeEngine, PicPatchSdkError } from 'picpatchsdk';
import type { EditInput, ReferenceGroup, ImageClient } from 'picpatchsdk';
import type { Settings } from './settings.ts';
import type { Runner } from './queue.ts';
import type { Sessions } from './sessions.ts';

/**
 * All image generation, validation and publication belong to the public SDK.
 * Consecutive runs of the same model and resources share one client, so its worker process and imports start once;
 * any failure or cancellation closes it, and the queue releases it when it goes idle.
 */
export function inference(sessions: Sessions, settings: () => Settings): Runner {
  let held: { key: string; editor: ImageClient } | undefined;
  const release = async () => { const current = held; held = undefined; await current?.editor.dispose(); };
  const runner: Runner = async (sessionId, run, events) => {
    const config = settings();
    const selected = listModels().find(model => model.id === run.modelId);
    if (!selected) throw new PicPatchSdkError('INVALID_REQUEST', 'Choose an available model.');
    const opened = await openModel(config.registrations[run.modelId] ?? run.modelId, { profile: config.profile, signal: events.signal, onEvent: events.onEvent });
    if (opened.status !== 'present') throw new PicPatchSdkError('MODEL_IO', 'Prepare this model in Managed tools before running it.');
    let nativeExecutable = config.profile.nativeExecutable;
    if (selected.runtime.name === 'stable-diffusion.cpp' && !nativeExecutable) {
      const native = await inspectNativeEngine({ profile: config.profile, signal: events.signal, onEvent: events.onEvent });
      if (native.status !== 'ready') throw new PicPatchSdkError('ENGINE_MISSING', 'Install the native engine in Managed tools.');
      nativeExecutable = native.nativeExecutable;
    }
    const key = JSON.stringify([run.modelId, opened.model, config.profile, nativeExecutable ?? null]);
    if (held?.key !== key) {
      await release();
      held = { key, editor: createImageClient({ model: opened.model, profile: config.profile, ...(selected.runtime.name === 'stable-diffusion.cpp' ? { nativeExecutable } : {}) }) };
    }
    const editor = held.editor;
    const draft = run.draft;
    const caller = { name: 'picpatch', version: packageInfo.version };
    try {
      const common = { outputPath: join(sessions.directory(sessionId), 'outputs', `${run.id}.png`), size: { width: draft.width, height: draft.height }, seed: run.seed, parameters: draft.parameters, sidecar: { includeInputs: true }, ...(draft.control ? { control: { ...draft.control, image: await sessions.imagePath(sessionId, draft.control.image) } } : {}) };
      if (draft.mode === 'generate') {
        if (draft.source || draft.mask || draft.references.length || draft.outpaint) throw new PicPatchSdkError('INVALID_REQUEST', 'Switch to Edit to use source images, references or masks.');
        return { outcome: await editor.generate({ ...common, prompt: draft.text }, { ...events, caller }) };
      }
      const references = await Promise.all(draft.references.map(async group => ({ ...group, images: await Promise.all(group.images.map(image => sessions.imagePath(sessionId, image))) as ReferenceGroup['images'] })));
      const request: EditInput = { ...common, instruction: draft.text, ...(draft.source ? { sourceImage: await sessions.imagePath(sessionId, draft.source) } : {}), ...(references.length ? { references: references as [ReferenceGroup, ...ReferenceGroup[]] } : {}), ...(draft.mask ? { maskImage: await sessions.imagePath(sessionId, draft.mask) } : {}), ...(draft.outpaint ? { outpaint: { size: { width: draft.outpaint.width, height: draft.outpaint.height }, left: draft.outpaint.left, top: draft.outpaint.top } } : {}) };
      return { outcome: await editor.edit(request, { ...events, caller }) };
    } catch (error) {
      // A worker that failed or was cancelled is not trusted with the next run.
      if (held?.editor === editor) await release();
      throw error;
    }
  };
  runner.release = release;
  return runner;
}
