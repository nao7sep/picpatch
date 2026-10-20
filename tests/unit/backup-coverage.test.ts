import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { Application } from '../../src/main/core/service.ts';
let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'picpatch-backup-coverage-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
it('captures settings, session documents and painted masks, never imported copies', async () => {
  const captured: string[] = [];
  const bytes = new Map<string, Buffer>();
  const app = await Application.open({ root, sessions: join(root, 'sessions'), config: join(root, 'config.json'), state: join(root, 'state.json'), backups: join(root, 'backups.sqlite3') }, undefined, (path, content) => { captured.push(path); bytes.set(path, content); });
  const session = await app.sessions.create();
  const photo = join(root, 'photo.png'); await writeFile(photo, await sharp({ create: { width: 4, height: 4, channels: 3, background: '#808080' } }).png().toBuffer());
  const imported = await app.importImage(session.id, photo);
  expect(captured.some(path => path.endsWith(imported.id))).toBe(false);
  const painted = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#ffffff' } }).png().toBuffer();
  const mask = await app.mask(session.id, painted);
  const maskPath = await app.sessions.imagePath(session.id, mask.id);
  // The bytes captured are the bytes saved in the session.
  expect(bytes.get(maskPath)?.equals(painted)).toBe(true); expect((await readFile(maskPath)).equals(painted)).toBe(true);
  expect(mask).toMatchObject({ name: 'mask.png', bytes: painted.length });
  await expect(app.mask(session.id, Buffer.from('not an image'))).rejects.toThrow();
  expect(await readdir(join(root, 'sessions', session.id, 'assets'))).toHaveLength(2);
  await app.preferences({ theme: 'dark' });
  expect(captured).toContain(join(root, 'config.json'));
  expect(captured).toContain(join(root, 'sessions', session.id, 'session.json'));
});
