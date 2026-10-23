import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { inference, type InferenceSdk } from '../../src/main/core/inference.ts';
import { PicPatchSdkError } from 'picpatchsdk';
import { Queue } from '../../src/main/core/queue.ts';
import { Sessions } from '../../src/main/core/sessions.ts';
import type { Settings } from '../../src/main/core/settings.ts';
let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'picpatch-inference-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
/** A fake SDK whose clients count how often they are created and closed. */
function fakeSdk() {
  const clients: { model: string; disposed: boolean }[] = [];
  const sdk = {
    listModels: () => [{ id: 'a', runtime: { name: 'mflux', engine: 'python' } }, { id: 'b', runtime: { name: 'mflux', engine: 'python' } }, { id: 'n', runtime: { name: 'stable-diffusion.cpp', engine: 'native' } }],
    openModel: async (id: string) => ({ status: 'completed', model: { id } }),
    inspectNativeEngine: async () => ({ status: 'ready' }),
    createImageClient: (options: { model: { id: string } }) => {
      const client = { model: options.model.id, disposed: false };
      clients.push(client);
      return { generate: vi.fn(async () => ({ status: 'completed', image: { path: '/out.png' } })), edit: async () => ({}), dispose: vi.fn(async () => { client.disposed = true; }) };
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
  sdk.createImageClient = (() => ({ generate: async (input: Record<string, unknown>) => { request = input; return { status: 'completed' }; }, dispose: async () => {} })) as never;
  await attempt('a');
  expect(request).toMatchObject({ record: { includeInputs: true, caller: { name: 'picpatch' } } });
  expect(request).not.toHaveProperty('sidecar');
});


it.each(['TIMEOUT', 'TERMINATION_FAILED'] as const)('retains completed output and provenance when lowering concurrency evicts a client with %s', async code => {
  const sessions = new Sessions(root), session = await sessions.create();
  const settings: Settings = { version: 1, profile: { version: 1 }, registrations: {}, concurrency: 2 };
  const record = JSON.parse(await readFile(new URL('../fixtures/artifact.json', import.meta.url), 'utf8'));
  const teardown = new PicPatchSdkError(code, 'Worker teardown failed.');
  const held: (() => void)[] = [];
  const disposals: ReturnType<typeof vi.fn>[] = [];
  const { sdk } = fakeSdk();
  sdk.createImageClient = (() => {
    const index = disposals.length;
    const dispose = vi.fn(async () => { if (index === 0) throw teardown; });
    disposals.push(dispose);
    return {
      generate: async (request: { outputPath: string }) => {
        await new Promise<void>(resolve => { held[index] = resolve; });
        await writeFile(request.outputPath, 'published');
        return { status: 'completed', model: 'fixture', modelRevision: 'fixture', runtime: { name: 'fixture', version: '1' }, seed: 1, references: [], effectiveParameters: {}, image: { path: request.outputPath, mimeType: 'image/png', size: { width: 1, height: 1 } }, record };
      }, dispose,
    };
  }) as never;
  const runner = inference(() => sessions, () => settings, sdk);
  const queue = new Queue(sessions, runner, () => {}, () => settings.concurrency!);
  const runs = await queue.submit(session.id, { ...session.draft, modelIds: ['a'] }, 3);
  await vi.waitFor(() => expect(held.filter(Boolean)).toHaveLength(2));
  settings.concurrency = 1;
  held[0]!();
  await vi.waitFor(async () => expect((await sessions.get(session.id)).runs[0]!.status).toBe('completed'));
  expect(queue.state.issue).toMatchObject({ code });
  expect(disposals[0]).toHaveBeenCalledOnce();
  held[1]!(); await queue.settled();
  const saved = await sessions.get(session.id);
  expect(saved.runs.map(run => run.status)).toEqual(['completed', 'completed', 'queued']);
  expect(saved.runs[0]!.record).toEqual(record);
  expect(await readFile(join(sessions.directory(session.id), saved.runs[0]!.output!), 'utf8')).toBe('published');
  if (code === 'TERMINATION_FAILED') {
    await expect(queue.resume(session.id)).rejects.toThrow('termination is unconfirmed');
    await expect(queue.submit(session.id, session.draft, 1)).rejects.toThrow('termination is unconfirmed');
    expect(() => queue.requireIdle('error.finish_or_cancel_queued_work_before_changing_collections')).toThrow('termination is unconfirmed');
  } else {
    // A confirmed close may resume; failed clients are never reused.
    const third = queue.resume(session.id);
    await vi.waitFor(() => expect(queue.state.active[0]?.runId).toBe(runs[2]!.id));
    await vi.waitFor(() => expect(held[2]).toBeDefined());
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
  await vi.waitFor(() => expect(held.filter(Boolean)).toHaveLength(2));
  settings.concurrency = 1; held[0]!(); await first;
  held[1]!(); await second;
  expect(onTeardownError).toHaveBeenCalledOnce();
  const third = attempt('b');
  await vi.waitFor(() => expect(held[2]).toBeDefined());
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
