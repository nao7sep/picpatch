// PicPatch's own files carry the SDK's identity header with the app as writer; the databases keep it in SQLite form.
import type { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import { refused } from './refused-files.ts';
import { checkFileHeader, fileHeader, fileVersion, withFileHeader, type FileKind, type FileWriter, type HeaderCheck } from 'picpatchsdk/types';
import packageInfo from '../../../package.json' with { type: 'json' };

export const appWriter: FileWriter = { name: packageInfo.name, version: packageInfo.version };
/** The document as written: the header first, then the content. */
export const appFile = <T extends object>(kind: FileKind, content: T) => withFileHeader(kind, appWriter, content);
export { checkFileHeader, fileContent } from 'picpatchsdk/types';
export type { HeaderCheck } from 'picpatchsdk/types';

/**
 * Guards a save at the write itself: the file it replaces must be missing or this build's own, so a file refused at
 * read, or replaced since by a newer PicPatch, stays byte-identical. Disposable state may replace an unreadable file.
 */
export async function checkBeforeWrite(path: string, kind: FileKind, disposable = false): Promise<void> {
  let text: string;
  try { text = await readFile(path, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT' || disposable) return; throw refused(path, false, error); }
  let document: unknown;
  try { document = JSON.parse(text); } catch (error) { if (disposable) return; throw refused(path, false, error); }
  const check = checkFileHeader(document, kind);
  if (check.status === 'current' || (disposable && check.status === 'unreadable')) return;
  throw refused(path, check.status === 'newer');
}
/** A database whose header refuses it; it is left untouched and stays off. */
export class RefusedDatabase extends Error {
  // Plain fields, not parameter properties: the database workers run this file with Node's type stripping.
  readonly kind: FileKind; readonly newer: boolean;
  constructor(kind: FileKind, newer: boolean) {
    super(newer ? `The ${kind} database is from a newer PicPatch.` : `The ${kind} database is not a PicPatch ${kind} database.`);
    this.kind = kind; this.newer = newer;
  }
}

/**
 * Checks the header of a database opened for writing and rewrites its writer rows; an empty database gets the
 * header as it is created. Throws for a database of another format or a newer version, which is left untouched.
 */
export function openDatabaseHeader(db: DatabaseSync, kind: FileKind): void {
  let empty: boolean;
  try { empty = !db.prepare("SELECT 1 FROM sqlite_schema LIMIT 1").get(); } catch { throw new RefusedDatabase(kind, false); }
  if (empty) {
    const header = fileHeader(kind, appWriter);
    db.exec(`BEGIN; PRAGMA user_version = ${fileVersion}; CREATE TABLE file_header (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
    try {
      const insert = db.prepare('INSERT INTO file_header(key,value) VALUES(?,?)');
      insert.run('format.owner', header.format.owner); insert.run('format.kind', header.format.kind);
      writerRows(db);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    return;
  }
  let check: HeaderCheck;
  // A file that is not a SQLite database at all fails its first read; it is refused the same way.
  try { check = databaseHeader(db, kind); } catch { check = { status: 'unreadable' }; }
  if (check.status !== 'current') throw new RefusedDatabase(kind, check.status === 'newer');
  writerRows(db);
}
/** The same check as a JSON file's, from user_version and the file_header rows. */
export function databaseHeader(db: DatabaseSync, kind: FileKind): HeaderCheck {
  const version = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'file_header'").get()) return { status: 'unreadable' };
  const rows = db.prepare("SELECT key, value FROM file_header WHERE key IN ('format.owner','format.kind')").all() as { key: string; value: string }[];
  const field = (key: string) => rows.find(row => row.key === key)?.value;
  return checkFileHeader({ format: { owner: field('format.owner'), kind: field('format.kind'), version } }, kind);
}
function writerRows(db: DatabaseSync) {
  db.prepare("DELETE FROM file_header WHERE key LIKE 'writer.%'").run();
  const insert = db.prepare('INSERT INTO file_header(key,value) VALUES(?,?)');
  insert.run('writer.name', appWriter.name); insert.run('writer.version', appWriter.version);
}
