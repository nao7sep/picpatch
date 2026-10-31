import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { appWriter, databaseHeader, openDatabaseHeader } from '../../src/main/core/file-header.ts';
import packageInfo from '../../package.json' with { type: 'json' };
let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'picpatch-header-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
const rows = (db: DatabaseSync) => Object.fromEntries((db.prepare('SELECT key, value FROM file_header ORDER BY key').all() as { key: string; value: string }[]).map(row => [row.key, row.value]));

it('gives a new database its header and rewrites only the writer rows on later opens', () => {
  expect(appWriter).toEqual({ name: 'picpatch', version: packageInfo.version });
  const db = new DatabaseSync(join(root, 'records.sqlite3'));
  try {
    openDatabaseHeader(db, 'records');
    expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(1);
    expect(rows(db)).toEqual({ 'format.owner': 'picpatch', 'format.kind': 'records', 'writer.name': 'picpatch', 'writer.version': packageInfo.version });
    db.exec("UPDATE file_header SET value = 'something else' WHERE key = 'writer.name'; INSERT INTO file_header VALUES ('writer.caller.name', 'old');");
    // The writer is never read: any writer rows open, and opening for writing replaces them.
    expect(databaseHeader(db, 'records')).toEqual({ status: 'current' });
    openDatabaseHeader(db, 'records');
    expect(rows(db)).toEqual({ 'format.owner': 'picpatch', 'format.kind': 'records', 'writer.name': 'picpatch', 'writer.version': packageInfo.version });
  } finally { db.close(); }
});

it.each([
  ['a database without a header', 'CREATE TABLE records(id INTEGER PRIMARY KEY);', 'not a PicPatch'],
  ['another kind', "PRAGMA user_version = 1; CREATE TABLE file_header (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO file_header VALUES ('format.owner','picpatch'),('format.kind','backups');", 'not a PicPatch'],
  ['another owner', "PRAGMA user_version = 1; CREATE TABLE file_header (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO file_header VALUES ('format.owner','gptimg'),('format.kind','records');", 'not a PicPatch'],
  ['a missing version', "CREATE TABLE file_header (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO file_header VALUES ('format.owner','picpatch'),('format.kind','records');", 'not a PicPatch'],
  ['a newer version', "PRAGMA user_version = 2; CREATE TABLE file_header (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO file_header VALUES ('format.owner','picpatch'),('format.kind','records');", 'newer PicPatch'],
])('refuses %s and leaves it untouched', async (_name, setup, message) => {
  const path = join(root, 'records.sqlite3');
  const created = new DatabaseSync(path); created.exec(setup); created.close();
  const before = await readFile(path);
  const db = new DatabaseSync(path);
  try { expect(() => openDatabaseHeader(db, 'records')).toThrow(message); } finally { db.close(); }
  expect(await readFile(path)).toEqual(before);
});
