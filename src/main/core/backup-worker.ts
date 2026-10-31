import { parentPort } from 'node:worker_threads';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, chmod } from 'node:fs/promises';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDatabaseHeader } from './file-header.ts';
const launch = randomUUID();
let db: DatabaseSync | undefined;
let pending = Promise.resolve();
type Capture = { database: string; path: string; bytes: Uint8Array };
parentPort!.on('message', (message: Capture | { flush: string }) => {
  if ('flush' in message) { void pending.then(() => parentPort!.postMessage({ flushed: message.flush })); return; }
  pending = pending.then(async () => {
    try { await capture(message); parentPort!.postMessage({ written: true }); }
    catch (error) { parentPort!.postMessage({ written: true, issue: error instanceof Error ? error.stack ?? error.message : String(error) }); }
  });
});
/** Every capture arrives as the exact bytes just written: settings, a session document or a painted mask. */
async function capture(message: Capture) {
  if (!db) {
    await mkdir(dirname(message.database), { recursive: true, mode: 0o700 });
    // The handle is kept only once the schema exists, so a failed setup is retried by the next capture.
    const opened = new DatabaseSync(message.database);
    try {
      await chmod(message.database, 0o600);
      // A database of another format or a newer version is refused untouched, and backups stay off.
      openDatabaseHeader(opened, 'backups');
      opened.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS backups(id INTEGER PRIMARY KEY, session_id TEXT, path TEXT NOT NULL, content BLOB NOT NULL, content_sha256 TEXT NOT NULL, byte_size INTEGER NOT NULL, written_at_utc TEXT NOT NULL, UNIQUE(path, session_id)); CREATE INDEX IF NOT EXISTS backup_paths ON backups(path,id);');
    } catch (error) { opened.close(); throw error; }
    db = opened;
  }
  const bytes = Buffer.from(message.bytes); const digest = createHash('sha256').update(bytes).digest('hex');
  const latest = db.prepare('SELECT content_sha256 FROM backups WHERE path=? ORDER BY id DESC LIMIT 1').get(message.path);
  if (latest?.content_sha256 === digest) return;
  db.prepare('INSERT INTO backups(session_id,path,content,content_sha256,byte_size,written_at_utc) VALUES(?,?,?,?,?,?) ON CONFLICT(path,session_id) DO UPDATE SET content=excluded.content,content_sha256=excluded.content_sha256,byte_size=excluded.byte_size,written_at_utc=excluded.written_at_utc').run(launch, message.path, bytes, digest, bytes.length, new Date().toISOString());
}
