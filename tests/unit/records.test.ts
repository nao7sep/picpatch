import { mkdtemp, mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Worker } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { errorRecord } from '../../src/main/core/records.ts';
it('stores structured events and falls back to a session file when the database is unavailable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'picpatch-records-'));
  try {
    for (const fallback of [false, true]) {
      const directory = join(root, String(fallback)); await mkdir(directory);
      if (fallback) await mkdir(join(directory, 'records.sqlite3'));
      const worker = new Worker(new URL('../../src/main/core/records-worker.ts', import.meta.url), { workerData: { root: directory, session: '2026-10-19T00:00:00Z' } });
      const event = { time: '2026-10-19T00:00:01Z', level: 'info', message: 'Attempt completed.', runId: 'fixture' };
      try {
        await new Promise<void>((resolve, reject) => { worker.on('error', reject); worker.on('message', message => { if (message.written) resolve(); }); worker.postMessage(event); });
        if (fallback) { const files = await readdir(join(directory, 'logs')); expect(await readFile(join(directory, 'logs', files[0]!), 'utf8')).toContain(JSON.stringify(event)); }
        else { const db = new DatabaseSync(join(directory, 'records.sqlite3')); try { expect(JSON.parse(db.prepare('SELECT json FROM records').get()!.json as string)).toEqual(event); } finally { db.close(); } }
      } finally { await worker.terminate(); }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
}, 15_000);
it('keeps the cause chain and stack for diagnostics', () => {
  const error = new Error('outer', { cause: new TypeError('inner') });
  expect(errorRecord(error)).toMatchObject({ name: 'Error', message: 'outer', stack: expect.any(String), cause: { name: 'TypeError', message: 'inner' } });
});

import { RecordsReader } from '../../src/main/core/records-reader.ts';
import { recordsQuery, recordId } from '../../src/shared/records.ts';
it('validates untrusted query and detail arguments', () => {
  expect(() => recordsQuery({ current: true, level: 'fatal', search: '' })).toThrow();
  expect(() => recordsQuery({ current: true, level: 'all', search: 'x'.repeat(501) })).toThrow();
  expect(() => recordsQuery({ current: true, level: 'all', search: '', before: -1 })).toThrow();
  expect(() => recordId('1')).toThrow();
  expect(recordsQuery({ current: false, level: 'attention', search: '%_quoted' })).toEqual({ current: false, level: 'attention', search: '%_quoted' });
});
it('reads bounded historical pages, filters and full selected details without changing stored events', async () => {
  const root = await mkdtemp(join(tmpdir(), 'picpatch-records-reader-'));
  const reader = new RecordsReader(root, 'current', new URL('../../src/main/core/records-reader-worker.ts', import.meta.url));
  try {
    expect(await reader.query({ current: false, level: 'all', search: '' })).toEqual({ records: [], more: false });
    const db = new DatabaseSync(join(root, 'records.sqlite3'));
    db.exec('CREATE TABLE records(id INTEGER PRIMARY KEY,session TEXT,time TEXT,level TEXT,message TEXT,json TEXT)');
    const insert = db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?)');
    // One transaction: 205 separately synced commits take seconds on Windows.
    db.exec('BEGIN');
    for (let id = 1; id <= 205; id++) insert.run(id, id > 200 ? 'current' : 'previous', '2026-10-19T00:00:00Z', id % 2 ? 'info' : 'warn', `Message ${id}`, JSON.stringify({ message: `Message ${id}`, nested: { literal: '%_needle' }, time: '2026-10-19T00:00:00Z' }));
    db.exec('COMMIT');
    db.close();
    const first = await reader.query({ current: false, level: 'all', search: '' }); expect(first.records).toHaveLength(100); expect(first.more).toBe(true); expect(first.records[0]!.id).toBe(205);
    const second = await reader.query({ current: false, level: 'all', search: '', before: first.records.at(-1)!.id }); expect(second.records[0]!.id).toBe(105);
    const filtered = await reader.query({ current: true, level: 'attention', search: '%_needle' }); expect(filtered.records.map(row => row.id)).toEqual([204,202]);
    const detail = JSON.parse((await reader.detail(204))!); expect(detail).toMatchObject({ session: 'current', event: { nested: { literal: '%_needle' } } });
    expect(await reader.detail(999)).toBe(null);
  } finally { await reader.close(); await rm(root, { recursive: true, force: true }); }
});
it('rejects corrupt history without claiming an empty successful page', async () => {
  const root = await mkdtemp(join(tmpdir(), 'picpatch-records-corrupt-'));
  const reader = new RecordsReader(root, 'current', new URL('../../src/main/core/records-reader-worker.ts', import.meta.url));
  try {
    await mkdir(join(root, 'records.sqlite3'));
    await expect(reader.query({ current: false, level: 'all', search: '' })).rejects.toThrow();
  } finally { await reader.close(); await rm(root, { recursive: true, force: true }); }
});
