import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { listModels } from 'picpatchsdk';
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
  const manage = (app as unknown as { manage: <T>(work: (signal: AbortSignal) => Promise<T>) => Promise<T> }).manage.bind(app);
  const first = manage(async given => { signal = given; await held; return 'done'; });
  expect(app.managing).toBe(true); expect(app.resourcesBusy()).toBe(true);
  await expect(manage(async () => 'second')).rejects.toThrow('Wait for the current');
  expect(() => app.submit(session.id, session.draft, 1)).toThrow('Wait for the current resource operation');
  expect(() => app.resume(session.id)).toThrow('Wait for the current resource operation');
  await expect(app.preferences({ modelsDirectory: join(root, 'models') })).rejects.toThrow('Wait for the current resource operation');
  app.cancelManaged(); expect(signal.aborted).toBe(true);
  release(); await expect(first).resolves.toBe('done');
  expect(app.managing).toBe(false); expect(app.resourcesBusy()).toBe(false);
  await app.preferences({ modelsDirectory: join(root, 'models') });
});
