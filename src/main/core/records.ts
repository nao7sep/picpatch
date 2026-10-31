import { Worker } from 'node:worker_threads';
import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fallbackLog } from './fallback-log.ts';
import type { RecordsPage, RecordsQuery } from '../../shared/records.ts';
export interface AppRecord { time: string; level: 'debug' | 'info' | 'warn' | 'error'; message: string; [key: string]: unknown }
export function errorRecord(error: unknown): unknown {
  const seen = new Set<unknown>();
  function describe(value: unknown): unknown {
    if (!(value instanceof Error)) return String(value);
    if (seen.has(value)) return { name: value.name, message: 'Repeated cause' }; seen.add(value);
    const cause = value as Error & { code?: string; kind?: string; effect?: string; subject?: string; details?: unknown };
    return { name: cause.name, message: cause.message, stack: cause.stack, code: cause.code, kind: cause.kind, effect: cause.effect, subject: cause.subject, details: cause.details, ...(cause.cause ? { cause: describe(cause.cause) } : {}) };
  }
  return describe(error);
}
/**
 * Diagnostics never delay session saves or inference. One thread owns the records database and answers the Records
 * window's reads on its one connection, in order with the writes; main owns the fallback log.
 */
export class Records {
  private worker: Worker;
  /** Records sent but not yet acknowledged; a failed writer hands them to the fallback log. */
  private unacknowledged = new Map<number, { record: AppRecord; notify: boolean }>();
  /** Reads waiting for their answer, by request id; awaited without a bound. */
  private reads = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  private sequence = 0;
  private failed = false;
  private closing = false;
  readonly session = new Date().toISOString();
  private fallbackTail: Promise<void> = Promise.resolve();
  /** A refused records database is reported once, by path, and records go to the fallback log for the session. */
  constructor(private root: string, script: string | URL, private changed: () => void = () => {}, private refused: (newer: boolean, path: string) => void = () => {}) {
    this.worker = new Worker(script, { workerData: { root, session: this.session } });
    this.worker.on('message', message => {
      if (message.read) {
        const task = this.reads.get(message.id)!; this.reads.delete(message.id);
        if (message.error) task.reject(Object.assign(new Error(message.error.message), message.error)); else task.resolve(message.value);
        return;
      }
      if (!message.written) return;
      const entry = this.unacknowledged.get(message.id)!; this.unacknowledged.delete(message.id);
      if (message.stored) { if (entry.notify) this.changed(); return; }
      if (message.refused) {
        // The worker never opens a refused database again, so the session's records go straight to the fallback log.
        if (!this.failed) { this.failed = true; this.failReads(new Error('Records are unavailable.')); this.refused(message.refused.newer, join(this.root, 'records.sqlite3')); }
        this.fallback(entry.record); return;
      }
      // A record the database refused goes to the fallback log after the reason, in the same order as every other line.
      this.fallback({ time: new Date().toISOString(), level: 'error', message: 'Records database write failed.', error: message.failure });
      this.fallback(entry.record);
    });
    this.worker.on('error', error => this.workerFailed(error));
    this.worker.on('exit', code => { if (!this.closing) this.workerFailed(new Error(`Records writer exited (${code}).`)); });
  }
  write(level: AppRecord['level'], message: string, details: Record<string, unknown> = {}) { this.send({ ...details, time: new Date().toISOString(), level, message }, true); }
  /** Retain the failed read for inspection without its own acknowledgement restarting that read. */
  readFailed(error: unknown) { this.send({ error: errorRecord(error), time: new Date().toISOString(), level: 'error', message: 'Records could not be read.' }, false); }
  query(query: RecordsQuery): Promise<RecordsPage> { return this.read('query', query); }
  detail(id: number): Promise<string | null> { return this.read('detail', id); }
  private read(action: string, payload: unknown): Promise<any> {
    if (this.failed || this.closing) return Promise.reject(new Error('Records are unavailable.'));
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      this.reads.set(id, { resolve, reject });
      try { this.worker.postMessage({ id, action, payload }); }
      catch (error) { this.reads.delete(id); reject(error instanceof Error ? error : new Error(String(error))); }
    });
  }
  private failReads(error: Error) {
    for (const task of this.reads.values()) task.reject(error);
    this.reads.clear();
  }
  private send(record: AppRecord, notify: boolean) {
    if (this.failed) { this.fallback(record); return; }
    const id = ++this.sequence;
    try { this.worker.postMessage({ id, record }); this.unacknowledged.set(id, { record, notify }); }
    catch { this.fallback(record); }
  }
  private workerFailed(error: unknown) {
    if (this.failed) return;
    this.failed = true;
    process.stderr.write(`PicPatch records worker failed: ${String(error)}\n`);
    // A record the writer stored without acknowledging may be duplicated; optional diagnostics are not exactly-once.
    for (const { record } of this.unacknowledged.values()) this.fallback(record);
    this.unacknowledged.clear();
    this.failReads(new Error('Records are unavailable.'));
  }
  /** Without a working writer, records go to the launch's fallback log in order, and to stderr only when that fails. */
  private fallback(record: AppRecord) {
    const line = JSON.stringify(record) + '\n', path = fallbackLog(this.root, this.session);
    this.fallbackTail = this.fallbackTail
      .then(async () => { await mkdir(join(this.root, 'logs'), { recursive: true, mode: 0o700 }); await appendFile(path, line, { mode: 0o600 }); })
      .catch(() => { process.stderr.write(line); });
  }
  /** Waits for the writer to finish what it was sent; the quit's exit deadline bounds the wait. */
  async close(): Promise<void> {
    if (!this.failed) await new Promise<void>(resolve => {
      const done = (message: any) => { if (message.flushed) { this.worker.off('message', done); resolve(); } };
      this.worker.on('message', done); this.worker.once('exit', () => resolve());
      try { this.worker.postMessage({ flush: true }); } catch { resolve(); }
    });
    this.closing = true;
    this.failReads(new Error('Records closed.'));
    await this.worker.terminate(); await this.fallbackTail;
  }
}
