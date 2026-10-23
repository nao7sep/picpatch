import { Worker } from 'node:worker_threads';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { Backup, type BackupIssue } from '../../src/main/core/backup.ts';
it('retains the exact latest bytes per path and launch, and skips unchanged content', async () => {
  const root = await mkdtemp(join(tmpdir(), 'picpatch-backup-')); const database = join(root, 'backups.sqlite3');
  const worker = new Worker(new URL('../../src/main/core/backup-worker.ts', import.meta.url));
  try {
    worker.postMessage({ database, path: join(root, 'session.json'), bytes: Buffer.from('first') });
    worker.postMessage({ database, path: join(root, 'session.json'), bytes: Buffer.from('last') });
    // A painted mask arrives as its bytes, like the documents; the same mask again is not captured twice.
    const mask = Buffer.alloc(5 * 1024 * 1024, 3);
    worker.postMessage({ database, path: join(root, 'mask'), bytes: mask });
    worker.postMessage({ database, path: join(root, 'mask'), bytes: mask });
    await new Promise<void>((resolve, reject) => { worker.on('error', reject); worker.on('message', message => { if (message.flushed === 'test') resolve(); }); worker.postMessage({ flush: 'test' }); });
    const db = new DatabaseSync(database);
    try {
      const rows = db.prepare('SELECT * FROM backups ORDER BY id').all(); expect(rows).toHaveLength(2);
      expect(Buffer.from(rows[0]!.content as Uint8Array).toString()).toBe('last');
      // Buffer.equals: a deep comparison of 5 MB takes seconds.
      expect(Buffer.from(rows[1]!.content as Uint8Array).equals(mask)).toBe(true);
      expect(rows[1]!.content_sha256).toBe(createHash('sha256').update(mask).digest('hex'));
    } finally { db.close(); }
  } finally { await worker.terminate(); await rm(root, { recursive: true, force: true }); }
}, 15_000);
it('settles sent captures when closing, and reports a capture it could not keep', async () => {
  const root = await mkdtemp(join(tmpdir(), 'picpatch-backup-owner-'));
  try {
    const issues: BackupIssue[] = []; const script = new URL('../../src/main/core/backup-worker.ts', import.meta.url);
    const backup = new Backup(join(root, 'backups.sqlite3'), script, issue => issues.push(issue));
    await once(backup['worker'], 'online');
    backup.capture(join(root, 'config.json'), Buffer.from('{}')); await backup.close();
    const db = new DatabaseSync(join(root, 'backups.sqlite3'));
    try { expect(db.prepare('SELECT path FROM backups').all()).toEqual([{ path: join(root, 'config.json') }]); } finally { db.close(); }
    await mkdir(join(root, 'blocked.sqlite3'));
    const blocked = new Backup(join(root, 'blocked.sqlite3'), script, issue => issues.push(issue));
    await once(blocked['worker'], 'online');
    blocked.capture(join(root, 'config.json'), Buffer.from('{}')); await blocked.close();
    expect(issues).toEqual([{ kind: 'capture', diagnostic: expect.any(String) }]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
