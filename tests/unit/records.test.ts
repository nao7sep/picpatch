import { mkdtemp, mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Worker } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { errorRecord, Records } from '../../src/main/core/records.ts';
import { fallbackLog } from '../../src/main/core/fallback-log.ts';
import { once } from 'node:events';
it('stores structured events and falls back to a session file when the database is unavailable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'picpatch-records-'));
  try {
    for (const fallback of [false, true]) {
      const directory = join(root, String(fallback)); await mkdir(directory);
      if (fallback) await mkdir(join(directory, 'records.sqlite3'));
      const records = new Records(directory, new URL('../../src/main/core/records-worker.ts', import.meta.url));
      const event = { level: 'info', message: 'Attempt completed.', runId: 'fixture' };
      records.write('info', 'Attempt completed.', { runId: 'fixture' }); await records.close();
      if (fallback) {
        const lines = (await readFile(fallbackLog(directory, records.session), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
        expect(lines).toMatchObject([{ level: 'error', message: 'Records database write failed.', error: expect.any(String) }, event]);
      }
      else { const db = new DatabaseSync(join(directory, 'records.sqlite3')); try { expect(JSON.parse(db.prepare('SELECT json FROM records').get()!.json as string)).toMatchObject(event); } finally { db.close(); } }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
it('names the fallback log to the second and keeps records there once the writer thread has failed', async () => {
  expect(fallbackLog('/root', '2026-10-19T03:15:42.123Z')).toBe(join('/root', 'logs', '20261019-031542-utc.log'));
  const root = await mkdtemp(join(tmpdir(), 'picpatch-records-failed-'));
  try {
    const records = new Records(root, new URL('data:text/javascript,throw new Error("writer failed")'));
    await once(records['worker'], 'error');
    records.write('warn', 'Written without a writer.'); await records.close();
    const [file] = await readdir(join(root, 'logs'));
    expect(join(root, 'logs', file!)).toBe(fallbackLog(root, records.session));
    expect(await readFile(join(root, 'logs', file!), 'utf8')).toContain('Written without a writer.');
  } finally { await rm(root, { recursive: true, force: true }); }
});
it('keeps the cause chain and stack for diagnostics', () => {
  const error = new Error('outer', { cause: new TypeError('inner') });
  expect(errorRecord(error)).toMatchObject({ name: 'Error', message: 'outer', stack: expect.any(String), cause: { name: 'TypeError', message: 'inner' } });
});

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
  const reader = new Records(root, new URL('../../src/main/core/records-worker.ts', import.meta.url));
  try {
    // The first read creates the database the seed below fills from a connection of its own.
    expect(await reader.query({ current: false, level: 'all', search: '' })).toEqual({ records: [], more: false });
    const db = new DatabaseSync(join(root, 'records.sqlite3'));
    const insert = db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?)');
    // One transaction: 205 separately synced commits take seconds on Windows.
    db.exec('BEGIN');
    for (let id = 1; id <= 205; id++) insert.run(id, id > 200 ? reader.session : 'previous', '2026-10-19T00:00:00Z', id % 2 ? 'info' : 'warn', `Message ${id}`, JSON.stringify({ message: `Message ${id}`, nested: { literal: '%_needle' }, time: '2026-10-19T00:00:00Z' }));
    db.exec('COMMIT');
    db.close();
    const first = await reader.query({ current: false, level: 'all', search: '' }); expect(first.records).toHaveLength(100); expect(first.more).toBe(true); expect(first.records[0]!.id).toBe(205);
    const second = await reader.query({ current: false, level: 'all', search: '', before: first.records.at(-1)!.id }); expect(second.records[0]!.id).toBe(105);
    const filtered = await reader.query({ current: true, level: 'attention', search: '%_needle' }); expect(filtered.records.map(row => row.id)).toEqual([204,202]);
    const detail = JSON.parse((await reader.detail(204))!); expect(detail).toMatchObject({ session: reader.session, event: { nested: { literal: '%_needle' } } });
    expect(await reader.detail(999)).toBe(null);
  } finally { await reader.close(); await rm(root, { recursive: true, force: true }); }
});
it('stores a large diagnostic as a file beside its record and shows the record whole', async () => {
  const root = await mkdtemp(join(tmpdir(), 'picpatch-records-files-'));
  const worker = new Worker(new URL('../../src/main/core/records-worker.ts', import.meta.url), { workerData: { root, session: 'current' } });
  const output = `Traceback (most recent call last):\n${'  File "worker.py", line 1, in run\n'.repeat(3000)}RuntimeError: out of memory\n`;
  const event = { time: '2026-10-19T00:00:01Z', level: 'error', message: 'Image attempt ended without a result.', error: { details: { diagnostic: { phase: 'worker', output } } } };
  try {
    await new Promise<void>((resolve, reject) => { worker.on('error', reject); worker.on('message', message => { if (message.written) resolve(); }); worker.postMessage(event); });
    const [file] = await readdir(join(root, 'record-files'));
    expect(await readFile(join(root, 'record-files', file!), 'utf8')).toBe(output);
    const db = new DatabaseSync(join(root, 'records.sqlite3'));
    try {
      const row = db.prepare('SELECT id,json FROM records').get()!;
      expect(JSON.parse(row.json as string).error.details.diagnostic.output).toEqual({ $file: `record-files/${file}` });
      const detail = await new Promise<string>((resolve, reject) => { worker.on('message', message => { if (message.read) { if (message.error) reject(new Error(message.error.message)); else resolve(message.value); } }); worker.postMessage({ id: 2, action: 'detail', payload: row.id }); });
      expect(JSON.parse(detail).event).toEqual(event);
    } finally { db.close(); }
  } finally { await worker.terminate(); await rm(root, { recursive: true, force: true }); }
});
it('rejects corrupt history without claiming an empty successful page', async () => {
  const root = await mkdtemp(join(tmpdir(), 'picpatch-records-corrupt-'));
  const reader = new Records(root, new URL('../../src/main/core/records-worker.ts', import.meta.url));
  try {
    await mkdir(join(root, 'records.sqlite3'));
    await expect(reader.query({ current: false, level: 'all', search: '' })).rejects.toThrow();
  } finally { await reader.close(); await rm(root, { recursive: true, force: true }); }
});
