import { parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { chmodSync } from 'node:fs';
import { join } from 'node:path';
import { removeFiles, restoreLargeText, storeLargeText } from './record-files.ts';
import { recordsQuery, recordId, recordsPageSize } from '../../shared/records.ts';
const { root, session } = workerData as { root: string; session: string };
let database: DatabaseSync | undefined;
/** The one connection to the records database, for the writes and the Records window's reads alike. */
function open(): DatabaseSync {
  if (database) return database;
  // The handle is kept only once the schema exists, so a failed setup is retried by the next message.
  const opened = new DatabaseSync(join(root, 'records.sqlite3'));
  try {
    chmodSync(join(root, 'records.sqlite3'), 0o600);
    // The Records window lists one launch or one severity newest first; these indexes keep that from scanning every record.
    opened.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=100; CREATE TABLE IF NOT EXISTS records(id INTEGER PRIMARY KEY, session TEXT NOT NULL, time TEXT NOT NULL, level TEXT NOT NULL, message TEXT NOT NULL, json TEXT NOT NULL); CREATE INDEX IF NOT EXISTS records_session ON records(session, id); CREATE INDEX IF NOT EXISTS records_level ON records(level, id)');
  } catch (error) { opened.close(); throw error; }
  return database = opened;
}
/** A read answers after every record sent before it, in the order the messages came. */
function read(action: string, payload: unknown): unknown {
  const query = action === 'query' ? recordsQuery(payload) : undefined;
  const selected = action === 'detail' ? recordId(payload) : undefined;
  if (!query && !selected) throw new Error('Unknown records read.');
  const db = open();
  if (query) {
    const where: string[] = []; const parameters: (string | number)[] = [];
    if (query.current) { where.push('session = ?'); parameters.push(session); }
    if (query.before !== undefined) { where.push('id < ?'); parameters.push(query.before); }
    if (query.level === 'attention') where.push("level IN ('warn','error')");
    else if (query.level !== 'all') { where.push('level = ?'); parameters.push(query.level); }
    if (query.search) { where.push('instr(lower(json), lower(?)) > 0'); parameters.push(query.search); }
    const rows = db.prepare(`SELECT id,session,time,level,substr(message,1,1000) AS message FROM records ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`).all(...parameters, recordsPageSize + 1);
    return { records: rows.slice(0, recordsPageSize), more: rows.length > recordsPageSize };
  }
  const row = db.prepare('SELECT session,json FROM records WHERE id = ?').get(selected!);
  // Keep the stored event intact; session is database attribution, not an event override.
  return row ? JSON.stringify({ session: row.session, event: restoreLargeText(root, JSON.parse(row.json as string)) }, null, 2) : null;
}
parentPort!.on('message', message => {
  if (message.action) {
    try { parentPort!.postMessage({ read: true, id: message.id, value: read(message.action, message.payload) }); }
    catch (error) { parentPort!.postMessage({ read: true, id: message.id, error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : { message: String(error) } }); }
    return;
  }
  const record = message.record ?? message;
  if (record.flush) { parentPort!.postMessage({ flushed: true }); return; }
  let files: string[] = [];
  let failure: string | undefined;
  try {
    const db = open();
    const separated = storeLargeText(root, record);
    files = separated.files;
    db.prepare('INSERT INTO records(session,time,level,message,json) VALUES(?,?,?,?,?)').run(session, record.time, record.level, record.message, JSON.stringify(separated.record));
  } catch (error) {
    // Main writes the whole record to the fallback log, so files written for a row that was never stored are removed.
    removeFiles(root, files);
    failure = String(error);
  } finally { parentPort!.postMessage({ written: true, id: message.id, ...(failure === undefined ? { stored: true } : { stored: false, failure }) }); }
});
