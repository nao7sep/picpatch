import { chmod, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { readLaunchFiles } from '../../src/main/core/launch.ts';
import { RefusedFiles } from '../../src/main/core/refused-files.ts';
import { readPaneState, savePaneState } from '../../src/main/core/layout-state.ts';
import { Records } from '../../src/main/core/records.ts';
import { fallbackLog } from '../../src/main/core/fallback-log.ts';
import { Backup, type BackupIssue } from '../../src/main/core/backup.ts';
import { Sessions } from '../../src/main/core/sessions.ts';
import { Application } from '../../src/main/core/service.ts';
import { startupFailureHtml } from '../../src/main/startup-failure.ts';
import { layout } from '../../src/shared/layout.ts';

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'picpatch-refused-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
const writer = { name: 'picpatch', version: '1.0.0' };
const file = (kind: string, content: object = {}, version = 1) => JSON.stringify({ format: { owner: 'picpatch', kind, version }, writer, ...content });
const paths = () => ({ root, config: join(root, 'config.json'), state: join(root, 'state.json'), sessions: join(root, 'sessions'), backups: join(root, 'backups.sqlite3') });
async function snapshot(path: string) { return { bytes: await readFile(path), mode: (await stat(path)).mode }; }
/** A records or backups database a newer PicPatch wrote, with permissions PicPatch would otherwise tighten. */
async function newerDatabase(path: string, kind: string) {
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA user_version = 2; CREATE TABLE file_header (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO file_header VALUES ('format.owner','picpatch'),('format.kind','${kind}');`);
  db.close(); await chmod(path, 0o644);
}

it('stops the launch on every refused launch file at once, naming each, and writes nothing', async () => {
  const { config, state } = paths();
  await writeFile(config, file('config', {}, 2)); await writeFile(state, file('state', { railWidth: 300 }, 3));
  const before = [await snapshot(config), await snapshot(state)];
  let error: unknown; try { readLaunchFiles({ config, state }); } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(RefusedFiles);
  expect((error as RefusedFiles).files).toEqual([{ path: config, newer: true }, { path: state, newer: true }]);
  // Unreadable settings are valuable and stop the launch too; the message window names each file and what to do.
  await writeFile(config, '{"format":');
  try { readLaunchFiles({ config, state }); } catch (caught) { error = caught; }
  expect((error as RefusedFiles).files).toEqual([{ path: config, newer: false }, { path: state, newer: true }]);
  const html = startupFailureHtml(error, false);
  expect(html).toContain(`PicPatch left ${config} unchanged because it could not be read.`);
  expect(html).toContain(`PicPatch left ${state} unchanged because a newer version of PicPatch wrote it.`);
  expect(html).toContain('move them away to start fresh');
  expect(await snapshot(state)).toEqual(before[1]); expect(await readdir(root)).toEqual(['config.json', 'state.json']);
});

it('opens with default layout when state.json cannot be read, and replaces it on the next save', async () => {
  const { config, state } = paths();
  for (const contents of ['bad', JSON.stringify({ railWidth: 300 }), file('config', { railWidth: 300 })]) {
    await writeFile(state, contents);
    expect(readLaunchFiles({ config, state }).pane).toEqual({ railWidth: layout.railDefault, optionsPane: false });
  }
  await savePaneState(state, { railWidth: 300, optionsPane: true });
  expect(readPaneState(state)).toEqual({ railWidth: 300, optionsPane: true });
});

it('never saves over a state.json a newer PicPatch wrote during the session, and says so once', async () => {
  const { state } = paths();
  await savePaneState(state, { railWidth: 300, optionsPane: true });
  const newer = file('state', { railWidth: 400 }, 2); await writeFile(state, newer);
  await expect(savePaneState(state, { railWidth: 320, optionsPane: true })).rejects.toMatchObject({ notice: { key: 'error.file_newer', values: { path: state } } });
  // Later saves cannot succeed either; they are skipped instead of reporting the same refusal again.
  await expect(savePaneState(state, { railWidth: 330, optionsPane: true })).resolves.toBeUndefined();
  expect(await readFile(state, 'utf8')).toBe(newer);
});

it.each([
  ['newer', true, (path: string) => newerDatabase(path, 'records')],
  ['not a database', false, async (path: string) => { await writeFile(path, 'not sqlite at all'); await chmod(path, 0o644); }],
])('switches records off for the session, once and visibly, when the database is %s, leaving it untouched', async (_name, newer, make) => {
  const path = join(root, 'records.sqlite3'); await make(path);
  const before = await snapshot(path);
  const refusals: [boolean, string][] = [];
  const records = new Records(root, new URL('../../src/main/core/records-worker.ts', import.meta.url), () => {}, (isNewer, at) => refusals.push([isNewer, at]));
  records.write('info', 'First.'); records.write('info', 'Second.'); records.write('info', 'Third.');
  await records.close();
  expect(refusals).toEqual([[newer, path]]);
  const lines = (await readFile(fallbackLog(root, records.session), 'utf8')).trim().split('\n').map(line => JSON.parse(line).message);
  expect(lines).toEqual(['First.', 'Second.', 'Third.']);
  expect(await snapshot(path)).toEqual(before);
  expect((await readdir(root)).sort()).toEqual(['logs', 'records.sqlite3']);
});

it('switches backups off at launch when the database is refused, says so once and never touches it', async () => {
  const database = join(root, 'backups.sqlite3'); await newerDatabase(database, 'backups');
  const before = await snapshot(database);
  const issues: BackupIssue[] = [];
  const backup = new Backup(database, new URL('../../src/main/core/backup-worker.ts', import.meta.url), issue => issues.push(issue));
  await once(backup['worker'], 'online');
  // The refusal arrives before any save asks for a capture.
  await new Promise<void>(resolve => { const check = () => issues.length ? resolve() : setTimeout(check, 10); check(); });
  expect(issues).toEqual([{ kind: 'refused', path: database, newer: true }]);
  backup.capture(join(root, 'session.json'), Buffer.from('{}')); backup.capture(join(root, 'config.json'), Buffer.from('{}'));
  await backup.close();
  expect(issues).toHaveLength(1);
  expect(await snapshot(database)).toEqual(before);
});

it('refuses a session alone by its path, names it in the listing, and never saves over it', async () => {
  const sessions = new Sessions(join(root, 'sessions')); const kept = await sessions.create('Kept'); const other = await sessions.create('Other');
  const path = join(root, 'sessions', kept.id, 'session.json');
  const newer = JSON.stringify({ ...JSON.parse(await readFile(path, 'utf8')), format: { owner: 'picpatch', kind: 'session', version: 2 } });
  // A newer PicPatch saved the open session meanwhile: the next save here is refused at the write.
  await writeFile(path, newer);
  await expect(sessions.update(kept.id, value => { value.name = 'Renamed'; })).rejects.toMatchObject({ notice: { key: 'error.file_newer', values: { path } } });
  expect(await readFile(path, 'utf8')).toBe(newer);
  const listing = await new Sessions(join(root, 'sessions')).list();
  expect(listing.sessions.map(session => session.id)).toEqual([other.id]);
  expect(listing.failures).toMatchObject([{ id: kept.id, notice: { key: 'error.file_newer', values: { path } } }]);
  await writeFile(path, 'damaged');
  expect((await new Sessions(join(root, 'sessions')).list()).failures).toMatchObject([{ id: kept.id, notice: { key: 'error.file_unreadable', values: { path } } }]);
  expect(await readFile(path, 'utf8')).toBe('damaged');
});

it('keeps settings it cannot use on save, and never saves over a config.json replaced during the session', async () => {
  const { config } = paths();
  await writeFile(config, file('config', { theme: 'sepia', language: 'tlh', modelsKeptLoaded: 99, timeZone: 'Mars/Olympus', futureSetting: { kept: true } }));
  const app = await Application.open(paths());
  expect(app.settings).toMatchObject({ unread: { theme: 'sepia', language: 'tlh', modelsKeptLoaded: 99, timeZone: 'Mars/Olympus' } });
  expect(app.settings.theme).toBeUndefined();
  await app.preferences({ uiFont: 'Arial', timeZone: 'Asia/Tokyo' });
  const saved = JSON.parse(await readFile(config, 'utf8'));
  expect(saved).toMatchObject({ theme: 'sepia', language: 'tlh', modelsKeptLoaded: 99, timeZone: 'Asia/Tokyo', uiFont: 'Arial', futureSetting: { kept: true } });
  expect(saved).not.toHaveProperty('unread');
  const newer = file('config', {}, 2); await writeFile(config, newer);
  await expect(app.preferences({ uiFont: 'Helvetica' })).rejects.toMatchObject({ notice: { key: 'error.file_newer', values: { path: config } } });
  expect(await readFile(config, 'utf8')).toBe(newer);
});
