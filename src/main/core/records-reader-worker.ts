import { parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { recordsQuery, recordId, recordsPageSize } from '../../shared/records.ts';
import { restoreLargeText } from './record-files.ts';
const { root, session } = workerData as { root: string; session: string };
const path = join(root, 'records.sqlite3');
let database: DatabaseSync | undefined;
parentPort!.on('message', ({ id, action, payload }) => {
  try {
    const query = action === 'query' ? recordsQuery(payload) : undefined;
    const selected = action === 'detail' ? recordId(payload) : undefined;
    if (!query && !selected) throw new Error('Unknown records read.');
    if (!database) {
      let exists = true;
      try { statSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') exists = false; else throw error; }
      if (exists) { database = new DatabaseSync(path, { readOnly: true }); database.exec('PRAGMA busy_timeout=100'); }
    }
    let value: unknown = query ? { records: [], more: false } : null;
    if (database && query) {
      const where: string[] = []; const parameters: (string | number)[] = [];
      if (query.current) { where.push('session = ?'); parameters.push(session); }
      if (query.before !== undefined) { where.push('id < ?'); parameters.push(query.before); }
      if (query.level === 'attention') where.push("level IN ('warn','error')");
      else if (query.level !== 'all') { where.push('level = ?'); parameters.push(query.level); }
      if (query.search) { where.push('instr(lower(json), lower(?)) > 0'); parameters.push(query.search); }
      const rows = database.prepare(`SELECT id,session,time,level,substr(message,1,1000) AS message FROM records ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`).all(...parameters, recordsPageSize + 1);
      value = { records: rows.slice(0, recordsPageSize), more: rows.length > recordsPageSize };
    } else if (database && selected) {
      const row = database.prepare('SELECT session,json FROM records WHERE id = ?').get(selected);
      // Keep the stored event intact; session is database attribution, not an event override.
      value = row ? JSON.stringify({ session: row.session, event: restoreLargeText(root, JSON.parse(row.json as string)) }, null, 2) : null;
    }
    parentPort!.postMessage({ id, value });
  } catch (error) { parentPort!.postMessage({ id, error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : { message: String(error) } }); }
});
