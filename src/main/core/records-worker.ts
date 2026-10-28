import { parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { chmodSync } from 'node:fs';
import { join } from 'node:path';
import { removeFiles, storeLargeText } from './record-files.ts';
const { root, session } = workerData as { root: string; session: string };
let database: DatabaseSync | undefined;
parentPort!.on('message', message => {
  const record = message.record ?? message;
  if (record.flush) { parentPort!.postMessage({ flushed: true }); return; }
  let files: string[] = [];
  let failure: string | undefined;
  try {
    if (!database) {
      // The handle is kept only once the schema exists, so a failed setup is retried by the next write.
      const opened = new DatabaseSync(join(root, 'records.sqlite3'));
      try {
        chmodSync(join(root, 'records.sqlite3'), 0o600);
        // The Records window lists one launch or one severity newest first; these indexes keep that from scanning every record.
        opened.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=100; CREATE TABLE IF NOT EXISTS records(id INTEGER PRIMARY KEY, session TEXT NOT NULL, time TEXT NOT NULL, level TEXT NOT NULL, message TEXT NOT NULL, json TEXT NOT NULL); CREATE INDEX IF NOT EXISTS records_session ON records(session, id); CREATE INDEX IF NOT EXISTS records_level ON records(level, id)');
      } catch (error) { opened.close(); throw error; }
      database = opened;
    }
    const separated = storeLargeText(root, record);
    files = separated.files;
    database.prepare('INSERT INTO records(session,time,level,message,json) VALUES(?,?,?,?,?)').run(session, record.time, record.level, record.message, JSON.stringify(separated.record));
  } catch (error) {
    // Main writes the whole record to the fallback log, so files written for a row that was never stored are removed.
    removeFiles(root, files);
    failure = String(error);
  } finally { parentPort!.postMessage({ written: true, id: message.id, ...(failure === undefined ? { stored: true } : { stored: false, failure }) }); }
});
