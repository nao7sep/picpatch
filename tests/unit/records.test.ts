import { mkdtemp, mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Worker } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { errorRecord } from '../../src/app/records.ts';
it('stores structured events and falls back to a session file when the database is unavailable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'picpatch-records-'));
  try {
    for (const fallback of [false, true]) {
      const directory = join(root, String(fallback)); await mkdir(directory);
      if (fallback) await mkdir(join(directory, 'records.sqlite3'));
      const worker = new Worker(new URL('../../src/app/records-worker.ts', import.meta.url), { workerData: { root: directory, session: '2026-10-19T00:00:00Z' } });
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
