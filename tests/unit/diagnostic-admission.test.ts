import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { Records } from '../../src/main/core/records.ts';
import { Backup } from '../../src/main/core/backup.ts';

const heldWriter = new URL('data:text/javascript,import { parentPort } from "node:worker_threads"; parentPort.on("message", () => {});');

it('transfers every unacknowledged record to fallback after worker failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'picpatch-record-transfer-'));
  const records = new Records(root, new URL('data:text/javascript,import { parentPort } from "node:worker_threads"; parentPort.on("message", () => { throw new Error("failed before ACK"); });'));
  try {
    records.write('info', 'First pending'); records.write('info', 'Second pending');
    await new Promise<void>(resolve => records['worker'].once('error', () => resolve()));
    await records.close();
    const [file] = await readdir(join(root, 'logs'));
    const lines = (await readFile(join(root, 'logs', file!), 'utf8')).trim().split('\n').map(line => JSON.parse(line).message);
    expect(lines).toEqual(['First pending', 'Second pending']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('keeps the causal read diagnostic inspectable without notifying recovery, then notifies a genuine new record', async () => {
  const root = await mkdtemp(join(tmpdir(), 'picpatch-record-causal-')); const changed = vi.fn();
  const records = new Records(root, new URL('../../src/main/core/records-worker.ts', import.meta.url), changed);
  try {
    records.readFailed(new Error('Reader locked')); records.readFailed(new Error('Reader still locked'));
    records.write('info', 'Genuine new record');
    await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(1), { timeout: 5000 });
    await records.close();
    expect(changed).toHaveBeenCalledTimes(1);
    const { DatabaseSync } = await import('node:sqlite'); const db = new DatabaseSync(join(root, 'records.sqlite3'));
    try { expect(db.prepare('SELECT message FROM records ORDER BY id').all().map(row => row.message)).toEqual(['Records could not be read.', 'Records could not be read.', 'Genuine new record']); }
    finally { db.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('coalesces newest pending backups and sends only one before each acknowledgement', async () => {
  const backup = new Backup('/unused', heldWriter, () => {});
  const worker = backup['worker']; const post = vi.spyOn(worker, 'postMessage').mockImplementation(() => {});
  try {
    backup.capture('/first', Buffer.alloc(8, 1));
    backup.capture('/pending', Buffer.alloc(8, 2)); backup.capture('/pending', Buffer.alloc(8, 3));
    backup.capture('/other', Buffer.alloc(16, 4));
    expect(post).toHaveBeenCalledTimes(1); expect(backup['pending'].size).toBe(2);
    worker.emit('message', { written: true });
    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls[1]![0]).toMatchObject({ path: '/pending', bytes: Buffer.alloc(8, 3) });
    worker.emit('message', { written: true });
    expect(post.mock.calls[2]![0]).toMatchObject({ path: '/other' });
  } finally { await backup.terminate(); }
});
