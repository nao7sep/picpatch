import { parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, appendFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { fallbackLog } from './fallback-log.ts';
const { root, session } = workerData as { root: string; session: string };
let database: DatabaseSync | undefined;
parentPort!.on('message', record => {
  if (record.flush) { parentPort!.postMessage({ flushed: true }); return; }
  const json = JSON.stringify(record);
  let stored = false;
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
    database.prepare('INSERT INTO records(session,time,level,message,json) VALUES(?,?,?,?,?)').run(session, record.time, record.level, record.message, json);
    stored = true;
  } catch (error) {
    const diagnostic = JSON.stringify({ time: new Date().toISOString(), level: 'error', message: 'Records database write failed.', error: String(error) });
    try {
      const directory = join(root, 'logs'); mkdirSync(directory, { recursive: true, mode: 0o700 });
      appendFileSync(fallbackLog(root, session), `${diagnostic}\n${json}\n`, { mode: 0o600 });
    } catch { process.stderr.write(`${diagnostic}\n${json}\n`); }
  } finally { parentPort!.postMessage({ written: true, stored }); }
});
