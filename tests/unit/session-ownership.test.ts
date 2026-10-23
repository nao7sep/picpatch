import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { Sessions } from '../../src/main/core/sessions.ts';
const held = vi.hoisted(() => ({ source: '', wait: Promise.resolve(), denyRemoval: false, failAssetSync: false }));
vi.mock('node:fs/promises', async original => {
  const fs = await original<typeof import('node:fs/promises')>();
  return { ...fs, open: async (...args: Parameters<typeof fs.open>) => { if (args[0] === held.source) await held.wait; const handle = await fs.open(...args); if (held.failAssetSync && String(args[0]).endsWith('/assets')) vi.spyOn(handle, 'sync').mockRejectedValueOnce(Object.assign(new Error('Flush failed'), { code: 'EIO' })); return handle; },
    rm: async (...args: Parameters<typeof fs.rm>) => { if (held.denyRemoval && String(args[0]).includes('.removing-')) throw Object.assign(new Error('Denied'), { code: 'EACCES' }); return fs.rm(...args); } };
});
const roots: string[] = [];
afterEach(async () => { held.source = ''; held.denyRemoval = false; held.failAssetSync = false; await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() { const root = await mkdtemp(join(tmpdir(), 'picpatch-owner-')); roots.push(root); const sessions = new Sessions(join(root, 'sessions')); return { root, sessions, session: await sessions.create() }; }
it('joins an accepted import before its file-copy phase enters the metadata tail', async () => {
  const { root, sessions, session } = await fixture();
  const source = join(root, 'input.png'); await writeFile(source, await sharp({ create: { width: 2, height: 2, channels: 3, background: 'red' } }).png().toBuffer());
  let release!: () => void; held.source = source; held.wait = new Promise(resolve => { release = resolve; });
  const imported = sessions.importImage(session.id, source); const settled = vi.fn(); const wait = sessions.settled().then(settled);
  await Promise.resolve(); await Promise.resolve(); expect(settled).not.toHaveBeenCalled();
  release(); const asset = await imported; await wait;
  expect((await sessions.get(session.id)).assets[0]?.id).toBe(asset.id); expect(settled).toHaveBeenCalledOnce();
});
it('reports retained deletion files and a failed later retry without restoring the session', async () => {
  const { sessions, session } = await fixture(); held.denyRemoval = true;
  const result = await sessions.remove(session.id);
  expect(result.cleanup?.key).toBe('ui.session_cleanup_pending'); expect(result.cleanup?.values?.path).toContain('.removing-');
  const listed = await sessions.list(); expect(listed.sessions).toEqual([]); expect(listed.failures[0]?.message).toContain('Retained location');
  held.denyRemoval = false; expect((await sessions.list()).failures).toEqual([]);
});
it('saves draft-only changes with exact backup bytes and preserves history and foreign-reference checks', async () => {
  const { root, sessions, session } = await fixture(); sessions.focus(session.id);
  const saved: Buffer[] = [];
  const store = new Sessions(sessions.root, (_path, bytes) => saved.push(bytes)); store.focus(session.id);
  await store.saveDraft(session.id, { ...session.draft, text: 'new draft' });
  const bytes = await readFile(join(root, 'sessions', session.id, 'session.json'));
  expect(saved).toEqual([bytes]); expect(JSON.parse(bytes.toString()).draft.text).toBe('new draft');
  await store.saveDraft(session.id, { ...session.draft, text: 'new draft' }); expect(saved).toHaveLength(1);
  await expect(store.saveDraft(session.id, { ...session.draft, source: '99999999-9999-4999-8999-999999999999', mode: 'edit' })).rejects.toThrow('missing image');
  expect(await readFile(join(root, 'sessions', session.id, 'session.json'))).toEqual(bytes);
});

it.skipIf(process.platform === 'win32')('does not publish a mask reference when flushing its newly published asset name fails', async () => {
  const { sessions, session } = await fixture(); held.failAssetSync = true;
  const bytes = await sharp({ create: { width: 2, height: 2, channels: 3, background: 'white' } }).png().toBuffer();
  await expect(sessions.addImage(session.id, 'mask.png', bytes)).rejects.toThrow('Flush failed');
  expect((await sessions.get(session.id)).assets).toEqual([]);
});

it('does not expose the cached authority through an update result or retained callback value', async () => {
  const { sessions, session } = await fixture(); sessions.focus(session.id);
  let retained!: typeof session;
  const result = await sessions.update(session.id, value => { retained = value; value.name = 'Saved'; });
  result.name = 'Mutated after completion'; retained.draft.text = 'Mutated through callback';
  await sessions.saveDraft(session.id, { ...session.draft, text: 'New draft' });
  expect((await sessions.get(session.id)).name).toBe('Saved');
  expect((await sessions.get(session.id)).draft.text).toBe('New draft');
});
