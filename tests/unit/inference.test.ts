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
const masks: Record<string, string> = { a: 'composite', b: 'latent-composite', n: 'native' };
function fakeSdk() {
  const clients: { model: string; disposed: boolean }[] = [];
  const sdk = {
    prepareImageClient: async (id: string) => ({ status: 'completed', options: { model: { id } }, capabilities: { maskMode: masks[id] } }),
    createImageClient: (options: { model: { id: string } }) => {
      const client = { model: options.model.id, disposed: false };
      clients.push(client);
      return { generate: vi.fn(completedImage), edit: async () => ({}), dispose: vi.fn(async () => { client.disposed = true; }) };
    },
  } as unknown as InferenceSdk;
  return { sdk, clients };
}
it('reuses a warm client for the same model, keeps no more than Models kept loaded, closes the least recently used first and closes all on release', async () => {
  const sessions = new Sessions(root); const session = await sessions.create();
  const settings: Settings = { profile: {}, registrations: {} };
  const { sdk, clients } = fakeSdk(); const run = inference(() => sessions, () => settings, sdk);
  const events = { signal: new AbortController().signal, onEvent: () => {}, onProgress: () => {}, onTeardownError: () => {} };
  const attempt = (modelId: string) => run(session.id, { id: crypto.randomUUID(), modelId, seed: 1, draft: session.draft, status: 'running', created: '' }, events);
  await attempt('a'); await attempt('a');
  expect(clients).toHaveLength(1);
  await attempt('b');
  expect(clients.map(client => [client.model, client.disposed])).toEqual([['a', true], ['b', false]]);
  settings.modelsKeptLoaded = 2;
  await attempt('a'); await attempt('b'); await attempt('c');
  expect(clients.map(client => [client.model, client.disposed])).toEqual([['a', true], ['b', false], ['a', true], ['c', false]]);
  await run.release!(); expect(clients.every(client => client.disposed)).toBe(true);
});

it('runs with the SDK’s own preparation and refusal, and keeps the record without a sidecar', async () => {
  const sessions = new Sessions(root); const session = await sessions.create();
  const settings: Settings = { profile: {}, registrations: {} };
  const { sdk } = fakeSdk();
  const events = { signal: new AbortController().signal, onEvent: () => {}, onProgress: () => {}, onTeardownError: () => {} };
  const attempt = (modelId: string) => inference(() => sessions, () => settings, sdk)(session.id, { id: crypto.randomUUID(), modelId, seed: 1, draft: session.draft, status: 'running', created: '' }, events);
  const refusal = { status: 'refused', code: 'MODEL_REGISTRATION_VERSION_UNSUPPORTED', message: 'Newer.', details: { version: 2 } };
  const prepare = vi.fn(async () => refusal);
  sdk.prepareImageClient = prepare as never;
  const registration = { model: { variant: 'flux2-klein-4b' } } as never;
  settings.registrations.a = registration;
  expect(await attempt('a')).toEqual({ outcome: refusal });
  expect(prepare).toHaveBeenCalledWith('a', { profile: settings.profile, registration }, expect.objectContaining({ signal: events.signal }));
  sdk.prepareImageClient = fakeSdk().sdk.prepareImageClient;
  let request: Record<string, unknown> = {};
  sdk.createImageClient = (() => ({ generate: async (input: { outputPath: string; seed: number }) => { request = input; return completedImage(input); }, dispose: async () => {} })) as never;
  await attempt('a');
  expect(request).toMatchObject({ record: { includeInputs: true, caller: { name: 'picpatch' } } });
  expect(request).not.toHaveProperty('sidecar');
});


it.each(['TIMEOUT', 'TERMINATION_FAILED'] as const)('retains completed output and provenance when lowering Models kept loaded evicts a client with %s', async code => {
  const sessions = new Sessions(root), session = await sessions.create();
  const settings: Settings = { profile: {}, registrations: {}, modelsKeptLoaded: 2 };
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
  const queue = new Queue(sessions, runner);
  const runs = await queue.submit(session.id, { ...session.draft, modelIds: ['a', 'b'] }, 2);
  await until(() => expect(held[0]).toBeDefined()); held[0]!();
  await until(() => expect(held[1]).toBeDefined());
  // Lowered while the second model runs: publishing its result closes the first, whose close fails.
  settings.modelsKeptLoaded = 1; held[1]!();
  await until(async () => expect((await sessions.get(session.id)).runs[1]!.status).toBe('completed'));
  await queue.settled();
  expect(queue.state.issue).toMatchObject({ code });
  expect(disposals[0]).toHaveBeenCalledOnce();
  const saved = await sessions.get(session.id);
  expect(saved.runs.map(run => run.status)).toEqual(['completed', 'completed', 'queued', 'queued']);
  expect(saved.runs[1]!.record).toEqual(records[1]);
  const published = await readFile(join(sessions.directory(session.id), saved.runs[1]!.output!));
  expect(createHash('sha256').update(published).digest('hex')).toBe(records[1]!.sha256);
  expect(await sharp(published).metadata()).toMatchObject({ format: 'png', width: 1, height: 1 });
  if (code === 'TERMINATION_FAILED') {
    await expect(queue.resume(session.id)).rejects.toThrow('termination is unconfirmed');
    await expect(queue.submit(session.id, session.draft, 1)).rejects.toThrow('termination is unconfirmed');
    expect(() => queue.requireIdle('error.finish_or_cancel_queued_work_before_changing_collections')).toThrow('termination is unconfirmed');
  } else {
    // A confirmed close may resume; a closed client is never reused.
    const rest = queue.resume(session.id);
    await until(() => expect(queue.state.active?.runId).toBe(runs[2]!.id));
    await until(() => expect(held[2]).toBeDefined()); held[2]!();
    await until(() => expect(held[3]).toBeDefined()); held[3]!();
    await rest; await queue.settled();
    expect((await sessions.get(session.id)).runs.map(run => run.status)).toEqual(['completed', 'completed', 'completed', 'completed']);
    expect(disposals).toHaveLength(4);
    expect(disposals.every(dispose => dispose.mock.calls.length === 1)).toBe(true);
  }
});

it('preserves the primary operation failure and reports a subsequent disposal failure once', async () => {
  const sessions = new Sessions(root), session = await sessions.create();
  const settings: Settings = { profile: {}, registrations: {} };
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

it.each(['generate', 'edit'] as const)('keeps app teardown reporting outside the SDK %s options contract', async mode => {
  const sessions = new Sessions(root), session = await sessions.create();
  const settings: Settings = { profile: {}, registrations: {} };
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
    manifest: { model: 'test', source: { repository: 'test/model', revision: 'a'.repeat(40) }, components: [{ path: 'weights.bin', role: 'weights', bytes: 1, sha256: 'a'.repeat(64) }] },
  }, profile: {}, ...(modelId === 'n' ? { nativeExecutable: join(root, 'unused-native') } : { engineDirectory: join(root, 'unused-engine') }) });
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
  const run = inference(() => sessions, () => ({ profile: {}, registrations: {} }), sdk);
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
