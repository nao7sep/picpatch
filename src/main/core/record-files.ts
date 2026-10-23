import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A record keeps its diagnostics whole. Text this large, such as a worker's traceback or a process's error output,
 * is stored as a file beside the records database, so the database stays quick to list and search. Search does not
 * look inside these files. Records have no retention limit, and neither do their files.
 */
const threshold = 64 * 1024;
const folder = 'record-files';
type FileReference = { $file: string };
const isReference = (value: unknown): value is FileReference =>
  !!value && typeof value === 'object' && Object.keys(value).length === 1 && typeof (value as FileReference).$file === 'string';

/** Writes each large string in the record to its own file and returns the record with references; nothing is written for a small record. */
export function storeLargeText(root: string, record: unknown): { record: unknown; files: string[] } {
  const files: string[] = [];
  const separate = (value: unknown): unknown => {
    if (typeof value === 'string' && value.length > threshold) {
      const name = `${folder}/${randomUUID()}.txt`;
      if (!files.length) mkdirSync(join(root, folder), { recursive: true, mode: 0o700 });
      writeFileSync(join(root, name), value, { flag: 'wx', mode: 0o600 });
      files.push(name);
      return { $file: name } satisfies FileReference;
    }
    if (Array.isArray(value)) return value.map(separate);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, separate(item)]));
    return value;
  };
  try { return { record: separate(record), files }; }
  catch (error) { removeFiles(root, files); throw error; }
}
export function removeFiles(root: string, files: string[]): void {
  for (const name of files) { try { rmSync(join(root, name), { force: true }); } catch { /* A leftover file is only unused space. */ } }
}
/** Puts each referenced file's text back in place, for showing one record whole. */
export function restoreLargeText(root: string, record: unknown): unknown {
  if (isReference(record)) {
    if (!/^record-files\/[0-9a-f-]{36}\.txt$/.test(record.$file)) return record;
    try { return readFileSync(join(root, record.$file), 'utf8'); }
    catch { return { ...record, unavailable: true }; }
  }
  if (Array.isArray(record)) return record.map(item => restoreLargeText(root, item));
  if (record && typeof record === 'object') return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, restoreLargeText(root, item)]));
  return record;
}
