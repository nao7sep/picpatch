import { parentPort } from 'node:worker_threads';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, chmod } from 'node:fs/promises';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDatabaseHeader, RefusedDatabase } from './file-header.ts';
const launch = randomUUID();
let db: DatabaseSync | undefined;
/** A refused database stays refused for the session: it is never opened again, so nothing retries a change. */
let refusal: RefusedDatabase | undefined;
let pending = Promise.resolve();
type Capture = { database: string; path: string; bytes: Uint8Array };
parentPort!.on('message', (message: Capture | { flush: string } | { open: string }) => {
  if ('flush' in message) { void pending.then(() => parentPort!.postMessage({ flushed: message.flush })); return; }
  pending = pending.then(async () => {
    // Opening at launch reports a refused database before the first save needs it.
    if ('open' in message) { try { await open(message.open); } catch (error) { if (error instanceof RefusedDatabase) parentPort!.postMessage({ refused: { newer: error.newer } }); } return; }
    try { await capture(message); parentPort!.postMessage({ written: true }); }
    catch (error) { parentPort!.postMessage({ written: true, ...(error instanceof RefusedDatabase ? { refused: { newer: error.newer } } : { issue: error instanceof Error ? error.stack ?? error.message : String(error) }) }); }
  });
});
async function open(database: string): Promise<DatabaseSync> {
  if (db) return db;
  if (refusal) throw refusal;
  await mkdir(dirname(database), { recursive: true, mode: 0o700 });
  // The handle is kept only once the schema exists, so a failed setup is retried by the next capture.
  const opened = new DatabaseSync(database);
  try {
    // The header is checked before anything else touches the file: a database of another format or a newer version
    // is refused untouched, and backups stay off.
    openDatabaseHeader(opened, 'backups');
    await chmod(database, 0o600);
    opened.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS backups(id INTEGER PRIMARY KEY, session_id TEXT, path TEXT NOT NULL, content BLOB NOT NULL, content_sha256 TEXT NOT NULL, byte_size INTEGER NOT NULL, written_at_utc TEXT NOT NULL, UNIQUE(path, session_id)); CREATE INDEX IF NOT EXISTS backup_paths ON backups(path,id);');
  } catch (error) { opened.close(); if (error instanceof RefusedDatabase) refusal = error; throw error; }
  return db = opened;
}
/** Every capture arrives as the exact bytes just written: settings, a session document or a painted mask. */
async function capture(message: Capture) {
  const db = await open(message.database);
  const bytes = Buffer.from(message.bytes); const digest = createHash('sha256').update(bytes).digest('hex');
  const latest = db.prepare('SELECT content_sha256 FROM backups WHERE path=? ORDER BY id DESC LIMIT 1').get(message.path);
  if (latest?.content_sha256 === digest) return;
  db.prepare('INSERT INTO backups(session_id,path,content,content_sha256,byte_size,written_at_utc) VALUES(?,?,?,?,?,?) ON CONFLICT(path,session_id) DO UPDATE SET content=excluded.content,content_sha256=excluded.content_sha256,byte_size=excluded.byte_size,written_at_utc=excluded.written_at_utc').run(launch, message.path, bytes, digest, bytes.length, new Date().toISOString());
}
