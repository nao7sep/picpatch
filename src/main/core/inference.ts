import packageInfo from '../../../package.json' with { type: 'json' };
import { join } from 'node:path';
import { createImageClient, prepareImageClient } from 'picpatchsdk';
import type { ImageClient, ImageOutcome, ReferenceGroup } from 'picpatchsdk';

/** The SDK calls inference makes; tests substitute them. */
export interface InferenceSdk { createImageClient: typeof createImageClient; prepareImageClient: typeof prepareImageClient }
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
export function inference(current: () => Sessions, settings: () => Settings, sdk: InferenceSdk = { createImageClient, prepareImageClient }): Runner {
  const warm: { key: string; editor: ImageClient }[] = [];
  let busy = 0;
  const release = async () => { await Promise.all(warm.splice(0).map(client => client.editor.dispose())); };
  const evictBeyond = async (limit: number) => { while (warm.length && warm.length + busy > limit) await warm.shift()!.editor.dispose(); };
  const runner: Runner = async (sessionId, run, events) => {
    const { onTeardownError, ...callOptions } = events;
    const sessions = current();
    const config = settings();
    // The SDK opens the model and checks its engine; its refusal (an incomplete or newer registration) is the run's outcome.
    const registration = config.registrations[run.modelId];
    const prepared = await sdk.prepareImageClient(run.modelId, { profile: config.profile, ...(registration ? { registration } : {}) }, { signal: events.signal, onEvent: events.onEvent });
    if (prepared.status === 'refused') return { outcome: prepared };
    const key = JSON.stringify(prepared.options);
    const limit = Math.max(1, config.concurrency ?? 1);
    const index = warm.findIndex(client => client.key === key);
    let editor: ImageClient;
    if (index >= 0) editor = warm.splice(index, 1)[0]!.editor;
    else { await evictBeyond(limit - 1); editor = sdk.createImageClient(prepared.options); }
    busy++;
    const draft = run.draft;
    // The session keeps the full record; Save image decides what a shared copy holds. No sidecar is written beside session outputs.
    const record = { includeInputs: true, caller: { name: 'picpatch', version: packageInfo.version } };
    let outcome: ImageOutcome;
    try {
      const geometry = commandGeometry(draft, prepared.capabilities.maskMode);
      const image = (key: string) => sessions.imagePath(sessionId, key);
      // Every input the draft holds is passed on; the SDK refuses a generation that carries images.
      const inputs = {
        ...(draft.source ? { sourceImage: await image(draft.source) } : {}),
        ...(draft.mask ? { maskImage: await image(draft.mask) } : {}),
        ...(draft.references.length ? { references: await Promise.all(draft.references.map(async group => ({ ...group, images: await Promise.all(group.images.map(image)) as ReferenceGroup['images'] }))) as [ReferenceGroup, ...ReferenceGroup[]] } : {}),
        ...(draft.control ? { control: { ...draft.control, image: await image(draft.control.image) } } : {}),
      };
      const common = { ...geometry, ...inputs, outputPath: join(sessions.directory(sessionId), 'outputs', `${run.id}.png`), seed: run.seed, parameters: draft.parameters, record };
      outcome = draft.mode === 'generate' ? await editor.generate({ ...common, prompt: draft.text }, callOptions) : await editor.edit({ ...common, instruction: draft.text }, callOptions);
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
