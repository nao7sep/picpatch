import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import * as sdk from 'picpatchsdk';
import { Application, freshDraft } from '../../src/main/core/service.ts';
import { initialDraft } from '../../src/shared/session.ts';
import { Sessions } from '../../src/main/core/sessions.ts';

const recommended = 'flux2-klein-4b-4bit';
afterEach(() => vi.restoreAllMocks());
it('chooses a ready supported model before the supported Mac recommendation', () => {
  const models = [{ id: 'foreign', supported: false }, { id: recommended, supported: true }, { id: 'native', supported: true }];
  expect(freshDraft(models, { foreign: 'ready', native: 'ready' }).modelIds).toEqual(['native']);
});
it('keeps the Mac recommendation when supported and no supported model is ready', () => {
  expect(freshDraft([{ id: 'native', supported: true }, { id: recommended, supported: true }], { [recommended]: 'missing' }).modelIds).toEqual([recommended]);
});
it('chooses a supported host model when the Mac recommendation is unavailable', () => {
  expect(freshDraft([{ id: recommended, supported: false }, { id: 'native', supported: true }], { [recommended]: 'ready' }).modelIds).toEqual(['native']);
});
it('leaves the selection empty when this host has no supported models', () => {
  expect(freshDraft([{ id: recommended, supported: false }], { [recommended]: 'ready' }).modelIds).toEqual([]);
  expect(freshDraft([]).modelIds).toEqual([]);
});
it('applies host defaults only to a newly created session while retaining a saved draft verbatim', async () => {
  const root = await mkdtemp(join(tmpdir(), 'picpatch-fresh-default-'));
  const paths = { root, config: join(root, 'config.json'), sessions: join(root, 'sessions'), state: join(root, 'state.json'), backups: join(root, 'backups.sqlite3') };
  vi.spyOn(sdk, 'listModels').mockReturnValue([{ id: recommended, supported: false }, { id: 'native', supported: true }] as never);
  const app = await Application.open(paths);
  try {
    const authored = { ...initialDraft(), modelIds: ['authored-unavailable'], text: 'Keep this authored draft', width: 768 };
    const saved = await app.sessions.create('Saved', authored);
    const fresh = await app.create('Fresh'); expect(fresh.draft.modelIds).toEqual(['native']);
    expect((await app.sessions.get(saved.id)).draft).toEqual(authored);
    const reopened = new Sessions(paths.sessions);
    try { expect((await reopened.get(saved.id)).draft).toEqual(authored); }
    finally { await reopened.close(); }
  } finally { await app.sessions.close(); await rm(root, { recursive: true, force: true }); }
});
