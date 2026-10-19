import { parentPort } from 'node:worker_threads';
import { randomUUID, createHash } from 'node:crypto';
import { open, mkdir, chmod } from 'node:fs/promises';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const launch = randomUUID();
let db: DatabaseSync | undefined;
let pending = Promise.resolve();
type Capture = { database: string; path: string; bytes?: Uint8Array; sha256?: string };
parentPort!.on('message', (message: Capture | { flush: string }) => {
  if ('flush' in message) { void pending.then(() => parentPort!.postMessage({ flushed: message.flush })); return; }
  pending = pending.then(() => capture(message)).catch(error => { parentPort!.postMessage({ issue: error instanceof Error ? error.message : 'Backup history failed.' }); });
});
async function capture(message: Capture) {
  if (!db) {
    await mkdir(dirname(message.database), { recursive: true, mode: 0o700 });
    db = new DatabaseSync(message.database);
    await chmod(message.database, 0o600);
    db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=100; CREATE TABLE IF NOT EXISTS backups(id INTEGER PRIMARY KEY, session_id TEXT, path TEXT NOT NULL, content BLOB NOT NULL, content_sha256 TEXT NOT NULL, byte_size INTEGER NOT NULL, written_at_utc TEXT NOT NULL, UNIQUE(path, session_id)); CREATE INDEX IF NOT EXISTS backup_paths ON backups(path,id); CREATE TABLE IF NOT EXISTS backup_parts(backup_id INTEGER NOT NULL, part INTEGER NOT NULL, content BLOB NOT NULL, PRIMARY KEY(backup_id,part));');
  }
  const latest = db.prepare('SELECT content_sha256 FROM backups WHERE path=? ORDER BY id DESC LIMIT 1').get(message.path);
  const bytes = message.bytes === undefined ? undefined : Buffer.from(message.bytes);
  const expected = bytes ? createHash('sha256').update(bytes).digest('hex') : message.sha256;
  if (expected && latest?.content_sha256 === expected) return;
  // Binary inputs/results are streamed into parts, so history does not hold an entire large image in memory.
  db.exec('BEGIN');
  try {
    const row = db.prepare('INSERT INTO backups(session_id,path,content,content_sha256,byte_size,written_at_utc) VALUES(?,?,?,?,?,?) ON CONFLICT(path,session_id) DO UPDATE SET content=excluded.content,content_sha256=excluded.content_sha256,byte_size=excluded.byte_size,written_at_utc=excluded.written_at_utc RETURNING id').get(launch, message.path, bytes ?? Buffer.alloc(0), expected ?? '', bytes?.length ?? 0, new Date().toISOString())!;
    db.prepare('DELETE FROM backup_parts WHERE backup_id=?').run(row.id!);
    if (!bytes) {
      const file = await open(message.path, 'r'); const hash = createHash('sha256'); let size = 0, part = 0;
      try {
        const buffer = Buffer.alloc(4 * 1024 * 1024);
        for (;;) { const { bytesRead } = await file.read(buffer, 0, buffer.length, size); if (!bytesRead) break; const chunk = buffer.subarray(0, bytesRead); hash.update(chunk); db.prepare('INSERT INTO backup_parts VALUES(?,?,?)').run(row.id!, part++, chunk); size += bytesRead; }
      } finally { await file.close(); }
      const digest = hash.digest('hex');
      if (!expected || expected !== digest) throw new Error('Backup source changed; no history captured.');
      db.prepare('UPDATE backups SET content_sha256=?,byte_size=? WHERE id=?').run(digest, size, row.id!);
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
