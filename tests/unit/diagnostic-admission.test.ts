import { appendFile, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { Records } from '../../src/main/core/records.ts';
import { Backup, type BackupIssue } from '../../src/main/core/backup.ts';

vi.mock('node:fs/promises', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return { ...original, appendFile: vi.fn(original.appendFile) };
});

const heldWriter = new URL('data:text/javascript,import { parentPort } from "node:worker_threads"; parentPort.on("message", () => {});');

it('bounds the shared records budget while a writer is held and never joins stalled termination', async () => {
  const root = await mkdtemp(join(tmpdir(), 'picpatch-record-admission-'));
  const records = new Records(root, heldWriter);
  const worker = records['worker'];
  const terminate = worker.terminate.bind(worker);
  const warning = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  try {
    vi.spyOn(worker, 'terminate').mockImplementation(() => new Promise(() => {}));
    for (let i = 0; i < 1000; i++) records.write('info', `Record ${i}`);
    expect(records['queue']).toHaveLength(255); expect(records['active']).toBeDefined();
    expect(warning).toHaveBeenCalledTimes(1);
    const start = Date.now(); expect(await records.close()).toBe(false);
    expect(Date.now() - start).toBeLessThan(800); expect(records['queue']).toHaveLength(0);
  } finally { warning.mockRestore(); await terminate(); await rm(root, { recursive: true, force: true }); }
});

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
  } finally { await records.close(); await rm(root, { recursive: true, force: true }); }
});

it('keeps the causal read diagnostic inspectable without notifying recovery, then notifies a genuine new record', async () => {
  const root = await mkdtemp(join(tmpdir(), 'picpatch-record-causal-')); const changed = vi.fn();
  const records = new Records(root, new URL('../../src/main/core/records-worker.ts', import.meta.url), changed);
  try {
    records.readFailed(new Error('Reader locked')); records.readFailed(new Error('Reader still locked'));
    records.write('info', 'Genuine new record');
    // This checks notification ownership; worker startup is outside the optional shutdown deadline.
    await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(1), { timeout: 5000 });
    expect(await records.close()).toBe(true);
    expect(changed).toHaveBeenCalledTimes(1);
    const { DatabaseSync } = await import('node:sqlite'); const db = new DatabaseSync(join(root, 'records.sqlite3'));
    try { expect(db.prepare('SELECT message FROM records ORDER BY id').all().map(row => row.message)).toEqual(['Records could not be read.', 'Records could not be read.', 'Genuine new record']); }
    finally { db.close(); }
  } finally { await records.close(); await rm(root, { recursive: true, force: true }); }
});

it('coalesces newest pending backups, bounds distinct payloads and sends only one before each ACK', async () => {
  const issues: BackupIssue[] = []; const backup = new Backup('/unused', heldWriter, issue => issues.push(issue));
  const worker = backup['worker']; const post = vi.spyOn(worker, 'postMessage').mockImplementation(() => {});
  Object.defineProperty(backup, 'budget', { value: 32 });
  try {
    backup.capture('/first', Buffer.alloc(8, 1));
    backup.capture('/pending', Buffer.alloc(8, 2)); backup.capture('/pending', Buffer.alloc(8, 3));
    backup.capture('/other', Buffer.alloc(16, 4)); backup.capture('/omitted', Buffer.alloc(1));
    expect(post).toHaveBeenCalledTimes(1); expect(backup['resident']).toBe(32);
    expect(backup['pending'].size).toBe(2); expect(issues).toEqual([{ kind: 'unavailable' }]);
    worker.emit('message', { written: true, id: 1 });
    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls[1]![0]).toMatchObject({ path: '/pending', bytes: Buffer.alloc(8, 3) });
    worker.emit('message', { written: true, id: 2 }); worker.emit('message', { written: true, id: 3 });
    expect(backup['resident']).toBe(0); expect(await backup.close()).toBe(true);
  } finally { await backup.terminate(); }
});

it('bounds optional backup close even when both ACK and termination never settle', async () => {
  const backup = new Backup('/unused', heldWriter, () => {}); const worker = backup['worker'];
  const terminate = worker.terminate.bind(worker);
  vi.spyOn(worker, 'terminate').mockImplementation(() => new Promise(() => {}));
  try {
    backup.capture('/mask', Buffer.alloc(1024));
    const start = Date.now(); expect(await backup.close()).toBe(false);
    expect(Date.now() - start).toBeLessThan(800); expect(backup['resident']).toBe(0);
  } finally { await terminate(); }
});

it('keeps a stalled fallback inside the same admission bound and does not wait for it at close', async () => {
  const root = await mkdtemp(join(tmpdir(), 'picpatch-fallback-admission-'));
  const records = new Records(root, heldWriter); const warning = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  let release: () => void = () => {};
  vi.mocked(appendFile).mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
  try {
    records['worker'].emit('error', new Error('Writer unavailable'));
    records.write('info', 'Held fallback');
    await vi.waitFor(() => expect(appendFile).toHaveBeenCalled());
    for (let i = 0; i < 1000; i++) records.write('info', `Pending fallback ${i}`);
    expect(records['queue']).toHaveLength(255);
    const start = Date.now(); expect(await records.close()).toBe(false); expect(Date.now() - start).toBeLessThan(800);
    release(); await vi.waitFor(() => expect(records['active']).toBeUndefined());
  } finally { warning.mockRestore(); await records.close(); await rm(root, { recursive: true, force: true }); }
});

it('reports a termination deadline separately from actual backup termination', async () => {
  const backup = new Backup('/unused', heldWriter, () => {}); const worker = backup['worker'];
  const terminate = worker.terminate.bind(worker);
  const mock = vi.spyOn(worker, 'terminate').mockImplementation(() => new Promise(() => {}));
  try { expect(await backup.terminate()).toBe(false); }
  finally { mock.mockRestore(); expect(await backup.terminate()).toBe(true); await terminate(); }
});
