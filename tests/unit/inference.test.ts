import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { inference, type InferenceSdk } from '../../src/main/core/inference.ts';
import { PicPatchSdkError, createImageClient, type EditInput, type ArtifactRecord, type ModelCapabilities } from 'picpatchsdk';
import { Queue } from '../../src/main/core/queue.ts';
import { Sessions } from '../../src/main/core/sessions.ts';
import type { Settings } from '../../src/main/core/settings.ts';
import { until } from '../helpers/until.ts';
let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'picpatch-inference-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
/** A completed SDK boundary writes a real image and supplies the exact private artifact record. */
async function completedImage(request: { outputPath: string; seed: number }) {
  const bytes = await sharp({ create: { width: 1, height: 1, channels: 3, background: 'blue' } }).png().toBuffer();
  await writeFile(request.outputPath, bytes);
  const record: ArtifactRecord = JSON.parse(await readFile(new URL('../fixtures/artifact.json', import.meta.url), 'utf8'));
  record.image.filename = basename(request.outputPath); record.seed = request.seed;
  record.bytes = bytes.length; record.sha256 = createHash('sha256').update(bytes).digest('hex');
  return { status: 'completed' as const, model: record.model, modelRevision: record.modelRevision, runtime: record.runtime, seed: record.seed, references: [], effectiveParameters: record.effectiveParameters, image: { path: request.outputPath, mimeType: 'image/png' as const, size: record.image.size }, record };
}
/** A fake SDK whose clients count how often they are created and closed. */
function fakeSdk() {
  const clients: { model: string; disposed: boolean }[] = [];
  const sdk = {
    listModels: () => [{ id: 'a', capabilities: { maskMode: 'composite' }, runtime: { name: 'mflux', engine: 'python' } }, { id: 'b', capabilities: { maskMode: 'latent-composite' }, runtime: { name: 'mflux', engine: 'python' } }, { id: 'n', capabilities: { maskMode: 'native' }, runtime: { name: 'stable-diffusion.cpp', engine: 'native' } }],
    openModel: async (id: string) => ({ status: 'completed', model: { id } }),
    inspectNativeEngine: async () => ({ status: 'ready' }),
    createImageClient: (options: { model: { id: string } }) => {
      const client = { model: options.model.id, disposed: false };
      clients.push(client);
      return { generate: vi.fn(completedImage), edit: async () => ({}), dispose: vi.fn(async () => { client.disposed = true; }) };
    },
  } as unknown as InferenceSdk;
  return { sdk, clients };
}
it('reuses a warm client for the same model, never keeps more clients than the limit and closes them on release', async () => {
  const sessions = new Sessions(root); const session = await sessions.create();
  const settings: Settings = { version: 1, profile: { version: 1 }, registrations: {} };
  const { sdk, clients } = fakeSdk(); const run = inference(() => sessions, () => settings, sdk);
  const events = { signal: new AbortController().signal, onEvent: () => {}, onProgress: () => {}, onTeardownError: () => {} };
  const attempt = (modelId: string) => run(session.id, { id: crypto.randomUUID(), modelId, seed: 1, draft: session.draft, status: 'running', created: '' }, events);
  await attempt('a'); await attempt('a');
  expect(clients).toHaveLength(1);
  await attempt('b');
  expect(clients.map(client => [client.model, client.disposed])).toEqual([['a', true], ['b', false]]);
  settings.concurrency = 2;
  await Promise.all([attempt('a'), attempt('b')]);
  expect(clients.filter(client => !client.disposed)).toHaveLength(2);
  await run.release!(); expect(clients.every(client => client.disposed)).toBe(true);
});

it('runs with the SDK’s own refusal and engine state instead of inventing codes, and keeps the record without a sidecar', async () => {
  const sessions = new Sessions(root); const session = await sessions.create();
  const settings: Settings = { version: 1, profile: { version: 1 }, registrations: {} };
  const { sdk } = fakeSdk();
  const events = { signal: new AbortController().signal, onEvent: () => {}, onProgress: () => {}, onTeardownError: () => {} };
  const attempt = (modelId: string) => inference(() => sessions, () => settings, sdk)(session.id, { id: crypto.randomUUID(), modelId, seed: 1, draft: session.draft, status: 'running', created: '' }, events);
  const refusal = { status: 'refused', code: 'MODEL_REGISTRATION_VERSION_UNSUPPORTED', message: 'Newer.', details: { version: 2 } };
  sdk.openModel = (async () => refusal) as never;
  expect(await attempt('a')).toEqual({ outcome: refusal });
  sdk.openModel = (async (id: string) => ({ status: 'completed', model: { id } })) as never;
  sdk.inspectNativeEngine = (async () => ({ status: 'incompatible', code: 'ENGINE_CHECK_FAILED', message: 'Wrong revision.' })) as never;
  await expect(attempt('n')).rejects.toMatchObject({ code: 'ENGINE_INCOMPATIBLE', message: 'Wrong revision.' });
  let request: Record<string, unknown> = {};
  sdk.createImageClient = (() => ({ generate: async (input: { outputPath: string; seed: number }) => { request = input; return completedImage(input); }, dispose: async () => {} })) as never;
  await attempt('a');
  expect(request).toMatchObject({ record: { includeInputs: true, caller: { name: 'picpatch' } } });
  expect(request).not.toHaveProperty('sidecar');
});


it.each(['TIMEOUT', 'TERMINATION_FAILED'] as const)('retains completed output and provenance when lowering concurrency evicts a client with %s', async code => {
  const sessions = new Sessions(root), session = await sessions.create();
  const settings: Settings = { version: 1, profile: { version: 1 }, registrations: {}, concurrency: 2 };
  const records: ArtifactRecord[] = [];
  const teardown = new PicPatchSdkError(code, 'Worker teardown failed.');
  const held: (() => void)[] = [];
  const disposals: ReturnType<typeof vi.fn>[] = [];
  const { sdk } = fakeSdk();
  sdk.createImageClient = (() => {
    const index = disposals.length;
    const dispose = vi.fn(async () => { if (index === 0) throw teardown; });
    disposals.push(dispose);
    return {
      generate: async (request: { outputPath: string; seed: number }) => {
        await new Promise<void>(resolve => { held[index] = resolve; });
        const result = await completedImage(request); records[index] = result.record; return result;
      }, dispose,
    };
  }) as never;
  const runner = inference(() => sessions, () => settings, sdk);
  const queue = new Queue(sessions, runner, () => {}, () => settings.concurrency!);
  const runs = await queue.submit(session.id, { ...session.draft, modelIds: ['a'] }, 3);
  await until(() => expect(held.filter(Boolean)).toHaveLength(2));
  settings.concurrency = 1;
  held[0]!();
  await until(async () => expect((await sessions.get(session.id)).runs[0]!.status).toBe('completed'));
  expect(queue.state.issue).toMatchObject({ code });
  expect(disposals[0]).toHaveBeenCalledOnce();
  held[1]!(); await queue.settled();
  const saved = await sessions.get(session.id);
  expect(saved.runs.map(run => run.status)).toEqual(['completed', 'completed', 'queued']);
  expect(saved.runs[0]!.record).toEqual(records[0]);
  const published = await readFile(join(sessions.directory(session.id), saved.runs[0]!.output!));
  expect(createHash('sha256').update(published).digest('hex')).toBe(records[0]!.sha256);
  expect(await sharp(published).metadata()).toMatchObject({ format: 'png', width: 1, height: 1 });
  if (code === 'TERMINATION_FAILED') {
    await expect(queue.resume(session.id)).rejects.toThrow('termination is unconfirmed');
    await expect(queue.submit(session.id, session.draft, 1)).rejects.toThrow('termination is unconfirmed');
    expect(() => queue.requireIdle('error.finish_or_cancel_queued_work_before_changing_collections')).toThrow('termination is unconfirmed');
  } else {
    // A confirmed close may resume; failed clients are never reused.
    const third = queue.resume(session.id);
    await until(() => expect(queue.state.active[0]?.runId).toBe(runs[2]!.id));
    await until(() => expect(held[2]).toBeDefined());
    held[2]!(); await third; await queue.settled();
    expect((await sessions.get(session.id)).runs.map(run => run.status)).toEqual(['completed', 'completed', 'completed']);
    expect(disposals).toHaveLength(3);
    expect(disposals.every(dispose => dispose.mock.calls.length === 1)).toBe(true);
  }
});

it('preserves the primary operation failure and reports a subsequent disposal failure once', async () => {
  const sessions = new Sessions(root), session = await sessions.create();
  const settings: Settings = { version: 1, profile: { version: 1 }, registrations: {} };
  const { sdk } = fakeSdk();
  const primary = new PicPatchSdkError('INVALID_REQUEST', 'Inference request failed.');
  const cleanup = new PicPatchSdkError('TERMINATION_FAILED', 'Worker teardown failed.');
  const dispose = vi.fn(async () => { throw cleanup; });
  const create = vi.fn(() => ({ generate: async () => { throw primary; }, dispose }));
  sdk.createImageClient = create as never;
  const run = inference(() => sessions, () => settings, sdk), onTeardownError = vi.fn();
  const attempt = () => run(session.id, { id: crypto.randomUUID(), modelId: 'a', seed: 1, draft: session.draft, status: 'running', created: '' }, { signal: new AbortController().signal, onEvent: () => {}, onProgress: () => {}, onTeardownError });
  await expect(attempt()).rejects.toBe(primary);
  expect(onTeardownError).toHaveBeenCalledExactlyOnceWith(cleanup);
  await expect(attempt()).rejects.toBe(primary);
  expect(create).toHaveBeenCalledTimes(2);
  expect(dispose).toHaveBeenCalledTimes(2);
});

it('releases active ownership once after eviction fails, so later model switches still evict warm clients', async () => {
  const sessions = new Sessions(root), session = await sessions.create();
  const settings: Settings = { version: 1, profile: { version: 1 }, registrations: {}, concurrency: 2 };
  const { sdk } = fakeSdk();
  const held: (() => void)[] = [], disposals: ReturnType<typeof vi.fn>[] = [];
  sdk.createImageClient = (() => {
    const index = disposals.length;
    const dispose = vi.fn(async () => { if (index === 0) throw new PicPatchSdkError('TIMEOUT', 'Shutdown timed out.'); });
    disposals.push(dispose);
    return { generate: async () => { await new Promise<void>(resolve => { held[index] = resolve; }); return { status: 'refused', code: 'OUTPUT_CONFLICT', message: 'Already exists.', subject: '/out.png', details: {} }; }, dispose };
  }) as never;
  const run = inference(() => sessions, () => settings, sdk), onTeardownError = vi.fn();
  const attempt = (modelId: string) => run(session.id, { id: crypto.randomUUID(), modelId, seed: 1, draft: session.draft, status: 'running', created: '' }, { signal: new AbortController().signal, onEvent: () => {}, onProgress: () => {}, onTeardownError });
  const first = attempt('a'), second = attempt('a');
  await until(() => expect(held.filter(Boolean)).toHaveLength(2));
  settings.concurrency = 1; held[0]!(); await first;
  held[1]!(); await second;
  expect(onTeardownError).toHaveBeenCalledOnce();
  const third = attempt('b');
  await until(() => expect(held[2]).toBeDefined());
  expect(disposals[0]).toHaveBeenCalledOnce();
  expect(disposals[1]).toHaveBeenCalledOnce();
  held[2]!(); await third; await run.release!();
});


it.each(['generate', 'edit'] as const)('keeps app teardown reporting outside the SDK %s options contract', async mode => {
  const sessions = new Sessions(root), session = await sessions.create();
  const settings: Settings = { version: 1, profile: { version: 1 }, registrations: {} };
  const { sdk } = fakeSdk();
  const operation = vi.fn(async (_request: unknown, options: Record<string, unknown>) => {
    // The real SDK rejects unknown call options before running a model.
    expect(Object.keys(options).sort()).toEqual(['onEvent', 'onProgress', 'signal']);
    return { status: 'refused', code: 'OUTPUT_CONFLICT', message: 'Already exists.', subject: '/out.png', details: {} };
  });
  sdk.createImageClient = (() => ({ generate: operation, edit: operation, dispose: async () => {} })) as never;
  const run = inference(() => sessions, () => settings, sdk);
  await run(session.id, { id: crypto.randomUUID(), modelId: 'a', seed: 1, draft: { ...session.draft, mode }, status: 'running', created: '' }, { signal: new AbortController().signal, onEvent: () => {}, onProgress: () => {}, onTeardownError: () => {} });
  expect(operation).toHaveBeenCalledOnce(); await run.release!();
});

it.each(['a', 'b', 'n'])('maps canvas and painted-mask geometry through real SDK validation for %s', async modelId => {
  const { validateEditRequest } = await import('picpatchsdk');
  const sessions = new Sessions(root), session = await sessions.create();
  const sourcePath = join(root, 'source.jpg'), maskPath = join(root, 'mask.png');
  // EXIF orientation swaps the imported source dimensions; masks use the displayed orientation.
  await sharp({ create: { width: 80, height: 48, channels: 3, background: 'blue' } }).withMetadata({ orientation: 6 }).jpeg().toFile(sourcePath);
  await sharp({ create: { width: 48, height: 80, channels: 3, background: 'white' } }).toColourspace('b-w').png().toFile(maskPath);
  const source = await sessions.importImage(session.id, sourcePath), mask = await sessions.importImage(session.id, maskPath);
  const { sdk } = fakeSdk(); const requests: Record<string, any>[] = [];
  const planner = createImageClient({ model: { variant: modelId === 'n' ? 'sd15-inpaint' : 'flux2-klein-4b', directory: root,
    ...(modelId === 'n' ? { checkpoint: 'weights.bin' } : {}),
    manifest: { version: 1, model: 'test', source: { repository: 'test/model', revision: 'a'.repeat(40) }, components: [{ path: 'weights.bin', role: 'weights', bytes: 1, sha256: 'a'.repeat(64) }] },
  }, profile: { version: 1 }, ...(modelId === 'n' ? { nativeExecutable: join(root, 'unused-native') } : { engineDirectory: join(root, 'unused-engine') }) });
  const caps: ModelCapabilities = { model: 'test', instructionEditing: true, referenceRoles: ['subject' as const], maskMode: modelId === 'n' ? 'native' as const : 'composite' as const, outpainting: true };
  sdk.createImageClient = (() => ({ edit: async (input: Record<string, unknown>) => {
    requests.push(input);
    const request = validateEditRequest({ ...input, model: 'test' }, caps);
    if (input.outpaint) expect(request.size).toEqual({ width: 1280, height: 1280 });
    else {
      // Public planning applies oriented source geometry without loading weights or a runtime.
      const plan = await planner.plan(input as unknown as EditInput);
      if (plan.status !== 'completed') throw new Error(plan.code);
      expect(plan.request.size).toEqual(modelId === 'n' ? { width: 1024, height: 1024 } : { width: 48, height: 80 });
    }
    return { status: 'refused', code: 'OUTPUT_CONFLICT', message: 'Test only.', details: {} };
  }, dispose: async () => {} })) as never;
  const run = inference(() => sessions, () => ({ version: 1, profile: { version: 1 }, registrations: {} }), sdk);
  const events = { signal: new AbortController().signal, onEvent: () => {}, onProgress: () => {}, onTeardownError: () => {} };
  const attempt = (draft: typeof session.draft) => run(session.id, { id: crypto.randomUUID(), modelId, seed: 1, draft, status: 'running', created: '' }, events);
  const draft = { ...session.draft, mode: 'edit' as const, text: 'Make it blue', source: source.id };
  await attempt({ ...draft, outpaint: { width: 1280, height: 1280, left: 128, top: 128 } });
  expect(requests[0]).toMatchObject({ size: { width: 1280, height: 1280 }, outpaint: { size: { width: 1280, height: 1280 }, left: 128, top: 128 } });
  await attempt({ ...draft, mask: mask.id });
  if (modelId === 'n') expect(requests[1]).toHaveProperty('size', { width: 1024, height: 1024 }); else expect(requests[1]).not.toHaveProperty('size');
  if (modelId !== 'n') {
    await sharp({ create: { width: 80, height: 49, channels: 3, background: 'blue' } }).withMetadata({ orientation: 6 }).jpeg().toFile(sourcePath);
    await sharp({ create: { width: 49, height: 80, channels: 3, background: 'white' } }).toColourspace('b-w').png().toFile(maskPath);
    const unalignedSource = await sessions.importImage(session.id, sourcePath), unalignedMask = await sessions.importImage(session.id, maskPath);
    await expect(attempt({ ...draft, source: unalignedSource.id, mask: unalignedMask.id })).rejects.toMatchObject({ code: 'INVALID_MASK' });
  }
  await planner.dispose(); await run.release!();
});
