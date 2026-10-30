import { afterEach, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Sessions } from '../../src/main/core/sessions.ts';
const held = vi.hoisted(() => ({ denyRemoval: false, denyScratch: false }));
vi.mock('node:fs/promises', async original => {
  const fs = await original<typeof import('node:fs/promises')>();
  return { ...fs, rm: async (...args: Parameters<typeof fs.rm>) => { if ((held.denyRemoval && String(args[0]).includes('.removing-')) || (held.denyScratch && String(args[0]).includes('.picpatch-'))) throw Object.assign(new Error('Denied'), { code: 'EACCES' }); return fs.rm(...args); } };
});
const roots: string[] = [];
afterEach(async () => { held.denyRemoval = false; held.denyScratch = false; await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() { const root = await mkdtemp(join(tmpdir(), 'picpatch-owner-')); roots.push(root); const sessions = new Sessions(join(root, 'sessions')); return { root, sessions, session: await sessions.create() }; }
it('reports retained deletion files, and a failed sweep at the next opening, without restoring the session', async () => {
  const { sessions, session } = await fixture(); held.denyRemoval = true;
  const result = await sessions.remove(session.id);
  expect(result.cleanup?.key).toBe('ui.session_cleanup_pending'); expect(result.cleanup?.values?.path).toContain('.removing-');
  expect((await sessions.list()).sessions).toEqual([]);
  const listed = await new Sessions(sessions.root).list(); expect(listed.sessions).toEqual([]); expect(listed.failures[0]?.message).toContain('Retained location');
  held.denyRemoval = false; expect((await new Sessions(sessions.root).list()).failures).toEqual([]);
  expect(await readdir(sessions.root)).toEqual([]);
});
it('clears run folders left in session outputs when the collection opens, keeping outputs and other files', async () => {
  const { sessions, session } = await fixture();
  const outputs = join(sessions.root, session.id, 'outputs');
  await mkdir(join(outputs, '.picpatch-abc123'), { recursive: true }); await writeFile(join(outputs, '.picpatch-abc123', 'worker.png'), 'x');
  await writeFile(join(outputs, 'kept.png'), 'x'); await writeFile(join(outputs, '.picpatch-note'), 'x');
  await new Sessions(sessions.root).list();
  expect((await readdir(outputs)).sort()).toEqual(['.picpatch-note', 'kept.png']);
});
it('keeps a recovery folder holding a finished image, and reports a run folder it cannot remove', async () => {
  const { sessions, session } = await fixture();
  const outputs = join(sessions.root, session.id, 'outputs');
  await mkdir(join(outputs, '.picpatch-saved'), { recursive: true }); await writeFile(join(outputs, '.picpatch-saved', 'complete.png'), 'x');
  await mkdir(join(outputs, '.picpatch-stuck'), { recursive: true });
  held.denyScratch = true;
  const listed = await new Sessions(sessions.root).list();
  expect(listed.failures).toEqual([{ id: session.id, message: expect.stringContaining(join(outputs, '.picpatch-stuck')) }]);
  expect(listed.failures[0]!.message).toContain('interrupted run');
  held.denyScratch = false;
  expect((await new Sessions(sessions.root).list()).failures).toEqual([]);
  expect(await readdir(outputs)).toEqual(['.picpatch-saved']);
});
it('stops sweeping run folders once work has started, leaving them for the next opening', async () => {
  const { sessions, session } = await fixture();
  const outputs = join(sessions.root, session.id, 'outputs');
  await mkdir(join(outputs, '.picpatch-running'), { recursive: true });
  let idle = false;
  await new Sessions(sessions.root, () => {}, false, () => idle).list();
  expect(await readdir(outputs)).toEqual(['.picpatch-running']);
  idle = true;
  await new Sessions(sessions.root, () => {}, false, () => idle).list();
  expect(await readdir(outputs)).toEqual([]);
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

it('does not expose the cached authority through an update result or retained callback value', async () => {
  const { sessions, session } = await fixture(); sessions.focus(session.id);
  let retained!: typeof session;
  const result = await sessions.update(session.id, value => { retained = value; value.name = 'Saved'; });
  result.name = 'Mutated after completion'; retained.draft.text = 'Mutated through callback';
  await sessions.saveDraft(session.id, { ...session.draft, text: 'New draft' });
  expect((await sessions.get(session.id)).name).toBe('Saved');
  expect((await sessions.get(session.id)).draft.text).toBe('New draft');
});
