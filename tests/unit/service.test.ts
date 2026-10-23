import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { listModels, PicPatchSdkError, verifyModel, type ModelManifest, type ModelVerificationOptions } from 'picpatchsdk';
import { Application, downloadableModel, exportDefaultPath, pythonToolDirectories } from '../../src/main/core/service.ts';
import { initialDraft, type Session } from '../../src/shared/session.ts';
let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'picpatch-service-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
const open = () => Application.open({ root, config: join(root, 'config.json'), sessions: join(root, 'sessions'), state: join(root, 'state.json'), backups: join(root, 'backups.sqlite3') });

it('downloads only pinned models this computer can run', () => {
  for (const model of listModels()) {
    if (model.acquisition === 'pinned' && model.supported) expect(downloadableModel(model.id)).toEqual(model);
    else expect(() => downloadableModel(model.id)).toThrow('No downloadable bundle');
  }
  expect(() => downloadableModel('not-a-model')).toThrow('No downloadable bundle');
  expect(() => downloadableModel(undefined)).toThrow('No downloadable bundle');
});
it('looks for engine build tools on PATH and in the Homebrew folders a Finder launch lacks', () => {
  expect(pythonToolDirectories('/usr/bin:relative:/opt/homebrew/bin:', ':')).toEqual(['/usr/bin', '/opt/homebrew/bin', '/usr/local/bin']);
  expect(pythonToolDirectories(undefined, ':')).toEqual(['/opt/homebrew/bin', '/usr/local/bin']);
});
it('suggests the image number shown in the conversation, in the folder the last save used', () => {
  const run = (id: string, output?: string) => ({ id, modelId: 'model', seed: 1, draft: initialDraft(), status: output ? 'completed' as const : 'failed' as const, created: '', ...(output ? { output } : {}) });
  const session: Session = { version: 1, id: 'session', name: 'Holiday', created: '', updated: '', draft: initialDraft(), assets: [], runs: [run('first', 'outputs/first.png'), run('failed'), run('third', 'outputs/third.png')] };
  const name = exportDefaultPath(session, 'third', undefined);
  expect(name).toMatch(/3/); expect(exportDefaultPath(session, 'third', join(root, 'saved'))).toBe(join(root, 'saved', name));
  expect(() => exportDefaultPath(session, 'failed', undefined)).toThrow(); expect(() => exportDefaultPath(session, 'missing', undefined)).toThrow();
});
it('runs one resource operation at a time, holds image work back meanwhile, and cancels it', async () => {
  const app = await open(); const session = await app.sessions.create();
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  let signal!: AbortSignal;
  const manage = (app as unknown as { manage: <T>(target: { action: string }, work: (call: { signal: AbortSignal }) => Promise<T>) => Promise<T> }).manage.bind(app);
  const first = manage({ action: 'verify' }, async call => { signal = call.signal; await held; return 'done'; });
  expect(app.managing).toBe(true); expect(app.resourcesBusy()).toBe(true);
  expect(() => manage({ action: 'verify' }, async () => 'second')).toThrow('Wait for the current');
  expect(() => app.submit(session.id, session.draft, 1)).toThrow('Wait for the current resource operation');
  expect(() => app.resume(session.id)).toThrow('Wait for the current resource operation');
  await expect(app.preferences({ modelsDirectory: join(root, 'models') })).rejects.toThrow('Wait for the current resource operation');
  app.cancelManaged(); expect(signal.aborted).toBe(true);
  release(); await expect(first).resolves.toBe('done');
  expect(app.managing).toBe(false); expect(app.resourcesBusy()).toBe(false);
  await app.preferences({ modelsDirectory: join(root, 'models') });
});
it('owns each model operation end to end: progress, one correlated result, and a cancel that leaves image work alone', async () => {
  const pushed: string[] = [];
  const diagnostics: { event?: { name: string } }[] = [];
  const app = await Application.open({ root, config: join(root, 'config.json'), sessions: join(root, 'sessions'), state: join(root, 'state.json'), backups: join(root, 'backups.sqlite3') }, scope => pushed.push(scope ?? 'changed'), undefined, (_level, _message, details) => diagnostics.push(details));
  const session = await app.sessions.create();
  app.queue.state.paused = true; await app.queue.submit(session.id, session.draft, 1);
  const manage = (app as unknown as { manage: <T>(target: { action: string; modelId?: string }, work: (call: ModelVerificationOptions & { signal: AbortSignal }) => Promise<T>) => Promise<T> }).manage.bind(app);
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  const bytes = Buffer.from('model verification fixture');
  await writeFile(join(root, 'weights.bin'), bytes);
  const manifest: ModelManifest = { version: 1, model: 'fixture', source: { repository: 'test/model', revision: 'a'.repeat(40) }, components: [{ path: 'weights.bin', role: 'weights', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }] };
  const first = manage({ action: 'download', modelId: 'flux2-klein-4b-4bit' }, async call => {
    // Public verification exercises the SDK's actual progress dispatch and production debug filtering.
    await expect(verifyModel(root, manifest, call)).resolves.toHaveProperty('status', 'matches-manifest');
    await new Promise<void>((resolve, reject) => { call.signal.addEventListener('abort', () => reject(new PicPatchSdkError('CANCELLED', 'Stopped.')), { once: true }); held.then(resolve); });
  });
  await vi.waitFor(() => expect(app.managedState.active).toMatchObject({ id: 1, action: 'download', modelId: 'flux2-klein-4b-4bit', progress: { completed: 1, total: 1 } }));
  expect(diagnostics.some(record => record.event?.name === 'operation.stage')).toBe(true);
  expect(diagnostics.some(record => record.event?.name === 'operation.progress')).toBe(false);
  expect(app.managedState.last).toBeUndefined();
  app.cancelManaged(); await expect(first).rejects.toThrow('Stopped.');
  expect(app.managedState).toEqual({ last: { id: 1, action: 'download', modelId: 'flux2-klein-4b-4bit', status: 'cancelled' } });
  // The queued image run is untouched by the cancellation.
  expect((await app.sessions.get(session.id)).runs.map(run => run.status)).toEqual(['queued']); expect(app.queue.busy(session.id)).toBe(true);
  expect(pushed).toContain('managed');
  // A failed verification is a failure, not success; a refusal keeps the SDK's reason.
  await manage({ action: 'verify', modelId: 'flux2-klein-4b-4bit' }, async () => ({ status: 'invalid' }));
  expect(app.managedState.last).toMatchObject({ id: 2, action: 'verify', status: 'failed', notice: { key: 'error.model_files' } });
  await manage({ action: 'verify', modelId: 'flux2-klein-4b-4bit' }, async () => ({ status: 'refused', code: 'MODEL_MISSING', message: 'Missing.', details: {} }));
  expect(app.managedState.last).toMatchObject({ id: 3, status: 'refused', notice: { key: 'error.prepare_this_model_in_managed_models_before_running_it' } });
  release();
});
