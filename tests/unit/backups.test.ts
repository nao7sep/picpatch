import { Worker } from 'node:worker_threads';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
it('retains exact latest bytes per launch and streams verified binary history without protecting mismatches', async () => {
  const root = await mkdtemp(join(tmpdir(), 'picpatch-backup-')); const database = join(root, 'backups.sqlite3');
  const worker = new Worker(new URL('../../src/main/core/backup-worker.ts', import.meta.url));
  try {
    worker.postMessage({ database, path: join(root, 'session.json'), bytes: Buffer.from('first') });
    worker.postMessage({ database, path: join(root, 'session.json'), bytes: Buffer.from('last') });
    const bytes = Buffer.alloc(5 * 1024 * 1024, 3); const asset = join(root, 'image'); await writeFile(asset, bytes);
    worker.postMessage({ database, path: asset, sha256: createHash('sha256').update(bytes).digest('hex') });
    worker.postMessage({ database, path: asset, sha256: '0'.repeat(64) });
    await new Promise<void>((resolve, reject) => { worker.on('error', reject); worker.on('message', message => { if (message.flushed === 'test') resolve(); }); worker.postMessage({ flush: 'test' }); });
    const db = new DatabaseSync(database);
    try {
      const rows = db.prepare('SELECT * FROM backups ORDER BY id').all(); expect(rows).toHaveLength(2);
      expect(Buffer.from(rows[0]!.content as Uint8Array).toString()).toBe('last');
      const parts = db.prepare('SELECT content FROM backup_parts WHERE backup_id=? ORDER BY part').all(rows[1]!.id!);
      // Buffer.equals: a deep comparison of 5 MB takes seconds.
      expect(Buffer.concat(parts.map(part => Buffer.from(part.content as Uint8Array))).equals(bytes)).toBe(true);
    } finally { db.close(); }
  } finally { await worker.terminate(); await rm(root, { recursive: true, force: true }); }
}, 15_000);
