import { mkdtemp, writeFile, readFile, rm, cp, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Sessions } from '../../src/app/sessions.ts';
import { appPaths } from '../../src/app/paths.ts';
let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'picpatch-sessions-')); });
afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });
it('relocates a self-contained session after its source image and old collection disappear', async () => {
  const sessions = new Sessions(join(root, 'collection'));
  const session = await sessions.create(); const source = join(root, 'source.png'); await writeFile(source, 'source content');
  const asset = await sessions.importImage(session.id, source);
  await sessions.update(session.id, value => { value.draft.source = asset.id; value.draft.mode = 'edit'; value.draft.text = 'private instruction'; });
  await cp(sessions.root, join(root, 'moved'), { recursive: true }); await rm(sessions.root, { recursive: true }); await rm(source);
  const moved = new Sessions(join(root, 'moved'));
  expect((await moved.get(session.id)).draft.text).toBe('private instruction');
  expect(await readFile(await moved.imagePath(session.id, asset.id), 'utf8')).toBe('source content');
  expect(await readFile(join(root, 'moved', session.id, 'session.json'), 'utf8')).not.toContain(root);
});
it('serializes concurrent draft changes without losing either field', async () => {
  const sessions = new Sessions(root); const s = await sessions.create();
  await Promise.all([sessions.update(s.id, value => { value.name = 'Chosen name'; }), sessions.update(s.id, value => { value.draft.text = 'Draft'; })]);
  expect(await new Sessions(root).get(s.id)).toMatchObject({ name: 'Chosen name', draft: { text: 'Draft' } });
});
it('preserves unknown formats and reports them beside readable sessions', async () => {
  const sessions = new Sessions(root); const a = await sessions.create(); const b = await sessions.create();
  const filename = join(root, a.id, 'session.json'); const newer = JSON.stringify({ ...a, version: 99 }); await writeFile(filename, newer);
  const fresh = new Sessions(root); const inventory = await fresh.list();
  expect(inventory.sessions.map(s => s.id)).toEqual([b.id]); expect(inventory.failures[0]?.id).toBe(a.id);
  await expect(fresh.update(a.id, () => {})).rejects.toThrow('Unsupported');
  expect(await readFile(filename, 'utf8')).toBe(newer);
  await expect(fresh.get('../outside')).rejects.toThrow('Invalid');
});
it('keeps exported and original files after explicitly deleting a session', async () => {
  const sessions = new Sessions(join(root, 'collection')); const s = await sessions.create();
  const outside = join(root, 'export.png'); await writeFile(outside, 'keep'); await sessions.importImage(s.id, outside);
  await sessions.remove(s.id); expect(await readFile(outside, 'utf8')).toBe('keep'); expect(await readdir(sessions.root)).toEqual([]);
});
it('honors the app environment override without reading the working directory', async () => {
  vi.stubEnv('PICPATCH_TEST_ROOT', root); vi.stubEnv('PICPATCH_DATA_DIR', '$PICPATCH_TEST_ROOT/app');
  expect(await appPaths()).toMatchObject({ root: join(root, 'app'), sessions: join(root, 'app', 'sessions') });
});
it('does not recreate an unavailable configured collection', async () => {
  const missing = join(root, 'unavailable-volume', 'sessions');
  const sessions = new Sessions(missing, () => {}, true);
  await expect(sessions.list()).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(readdir(join(root, 'unavailable-volume'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it.each(['canny', 'depth', 'pose'] as const)('retains %s conditioning when a session reopens', async kind => {
  const sessions = new Sessions(root); const session = await sessions.create();
  const input = join(root, 'map.png'); await writeFile(input, 'map fixture');
  const image = await sessions.importImage(session.id, input);
  await sessions.update(session.id, value => { value.draft.control = { kind, image: image.id, strength: 0.5 }; });
  expect((await new Sessions(root).get(session.id)).draft.control).toEqual({ kind, image: image.id, strength: 0.5 });
});
