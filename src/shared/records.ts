export type RecordLevel = 'debug' | 'info' | 'warn' | 'error';
export interface RecordsQuery { current: boolean; level: RecordLevel | 'all' | 'warningsAndErrors'; search: string; before?: number }
export interface RecordSummary { id: number; session: string; time: string; level: RecordLevel; message: string }
export interface RecordsPage { records: RecordSummary[]; more: boolean }
export const recordsPageSize = 100;
export function recordId(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new Error('Invalid record identifier.');
  return value;
}
export function recordsQuery(value: unknown): RecordsQuery {
  if (!value || typeof value !== 'object') throw new Error('Invalid records query.');
  const q = value as Record<string, unknown>;
  if (typeof q.current !== 'boolean' || typeof q.level !== 'string' || !['debug', 'info', 'warn', 'error', 'all', 'warningsAndErrors'].includes(q.level) || typeof q.search !== 'string' || q.search.length > 500) throw new Error('Invalid records query.');
  return { current: q.current, level: q.level as RecordsQuery['level'], search: q.search, ...(q.before === undefined ? {} : { before: recordId(q.before) }) };
}
