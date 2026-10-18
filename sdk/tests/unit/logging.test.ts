import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import * as fs from 'node:fs';
import { Writable } from 'node:stream';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { inspectModel, readProfile, type SdkEvent, type ProgressEvent } from '../../src/index.ts';
import { withDiagnostics } from '../../src/diagnostics.ts';
import { emitProgress } from '../../src/operations.ts';
vi.mock('node:fs', async original => { const actual = await original<typeof fs>(); return { ...actual, createWriteStream: vi.fn(actual.createWriteStream) }; });
const actual = await vi.importActual<typeof fs>('node:fs');
let directory: string;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'picpatch-logs-')); });
afterEach(async () => { vi.mocked(fs.createWriteStream).mockImplementation(actual.createWriteStream); await rm(directory, { recursive: true, force: true }); });
it('writes the same structured events to an explicit exclusive JSONL file and keeps records separate', async () => {
  const path = join(directory, 'profile.json'); await writeFile(path, '{"version":1}');
  const logPath = join(directory, 'operation.log'); const events: SdkEvent[] = [];
  const result = await readProfile(path, { logPath, onEvent: event => events.push(event) });
  expect(result).toEqual({ status: 'read', profile: { version: 1 }, log: { path: logPath, status: 'written' } });
  expect((await readFile(logPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line))).toEqual(events);
  const second = await readProfile(path, { logPath }); expect(second.log?.status).toBe('failed');
  expect((await readFile(logPath, 'utf8')).trim().split('\n')).toHaveLength(events.length);
});
it('contains a blocked log sink and failed event hook without hiding success', async () => {
  const sink = new Writable({ write() { /* Deliberately never settles until destroyed. */ } });
  vi.mocked(fs.createWriteStream).mockReturnValue(sink as fs.WriteStream);
  const result = await inspectModel(directory, { logPath: join(directory, 'blocked.log'), onEvent: () => { throw new Error('hook'); } });
  expect(result.log?.status).toBe('failed'); expect(result.status).toBe('unrecognized'); expect(sink.destroyed).toBe(true);
});
it('reports stages independently and throttles only real counts, preserving the final count', async () => {
  const events: SdkEvent[] = []; const progress: ProgressEvent[] = [];
  await withDiagnostics('test', { onEvent: (event: SdkEvent) => events.push(event), onProgress: (event: ProgressEvent) => progress.push(event) }, async options => {
    emitProgress(options, { stage: 'loading' });
    for (let completed = 0; completed <= 100; completed++) emitProgress(options, { stage: 'editing', completed, total: 100 });
  });
  expect(events.map(event => event.stage)).toEqual(['started', 'loading', 'editing', 'succeeded']);
  expect(progress).toEqual([{ type: 'progress', stage: 'editing', completed: 0, total: 100 }, { type: 'progress', stage: 'editing', completed: 100, total: 100 }]);
});
