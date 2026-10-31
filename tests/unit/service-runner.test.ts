import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PicPatchSdkError, verifyModel, type ModelManifest } from 'picpatchsdk';
import type { Runner } from '../../src/main/core/queue.ts';
import { Application } from '../../src/main/core/service.ts';
import { until } from '../helpers/until.ts';

const outbound = vi.hoisted(() => ({ runner: undefined as Runner | undefined }));
vi.mock('../../src/main/core/inference.ts', () => ({ inference: () => outbound.runner }));
let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'picpatch-service-runner-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
const paths = () => ({ root, config: join(root, 'config.json'), sessions: join(root, 'sessions'), state: join(root, 'state.json'), backups: join(root, 'backups.sqlite3') });
const refused = { status: 'refused' as const, code: 'OUTPUT_CONFLICT' as const, message: 'Fixture output exists.', subject: '/fixture-output.png', details: {} };
const manifest: ModelManifest = { model: 'fixture', source: { repository: 'test/model', revision: 'a'.repeat(40) }, components: [{ path: 'weights.bin', role: 'weights', bytes: 1, sha256: createHash('sha256').update('x').digest('hex') }] };

it('preserves the inference release hook through Application and waits for idle disposal to settle', async () => {
  let finish!: () => void;
  const held = new Promise<void>(resolve => { finish = resolve; });
  const release = vi.fn(() => held);
  outbound.runner = Object.assign(async () => ({ outcome: refused }), { release });
  const app = await Application.open(paths()), session = await app.sessions.create();
  await app.submit(session.id, { ...session.draft, text: 'A bowl' }, 1);
  await until(() => expect(release).toHaveBeenCalledOnce());
  let settled = false; const completion = app.queue.settled().then(() => { settled = true; });
  await Promise.resolve(); expect(settled).toBe(false);
  finish(); await completion;
  expect(settled).toBe(true);
  expect((await app.sessions.get(session.id)).runs[0]?.status).toBe('refused');
});

it('retains a production release failure in the queue gate and blocks later resource changes', async () => {
  const error = new PicPatchSdkError('TERMINATION_FAILED', 'The worker may still be running.');
  const release = vi.fn(async () => { throw error; });
  outbound.runner = Object.assign(async () => ({ outcome: refused }), { release });
  const app = await Application.open(paths()), session = await app.sessions.create();
  await app.submit(session.id, { ...session.draft, text: 'A bowl' }, 1); await app.queue.settled();
  expect(release).toHaveBeenCalledOnce();
  expect(app.queue.state).toMatchObject({ paused: true, issue: { code: 'TERMINATION_FAILED' } });
  await expect(app.preferences({ engineDirectory: join(root, 'different-engine') })).rejects.toThrow('termination is unconfirmed');
  await expect(app.submit(session.id, { ...session.draft, text: 'Another bowl' }, 1)).rejects.toThrow('termination is unconfirmed');
});

it.each(['sdk', 'pre-sdk', 'sdk-and-teardown'] as const)('records each distinct failure once through Application and Queue: %s', async scenario => {
  const diagnostics: { level: string; message: string; details: Record<string, any> }[] = [];
  const teardown = new PicPatchSdkError('TERMINATION_FAILED', 'Distinct worker teardown failure.');
  outbound.runner = async (_sessionId, _run, events) => {
    if (scenario === 'pre-sdk') throw new Error('Before SDK admission.');
    try {
      // Use public SDK dispatch, rather than manufacturing a terminal event that could bypass its filters.
      await verifyModel(join(root, 'missing-model'), manifest, { signal: events.signal, onEvent: events.onEvent, onProgress: events.onProgress });
      throw new Error('Expected model verification failure.');
    } catch (error) {
      if (scenario === 'sdk-and-teardown') events.onTeardownError(teardown);
      throw error;
    }
  };
  const app = await Application.open(paths(), undefined, undefined, (level, message, details) => diagnostics.push({ level, message, details }));
  const session = await app.sessions.create();
  const [run] = await app.submit(session.id, { ...session.draft, text: 'A bowl' }, 1); await app.queue.settled();
  const failures = diagnostics.filter(record => record.level === 'error');
  expect(failures).toHaveLength(scenario === 'sdk-and-teardown' ? 2 : 1);
  expect(failures.every(record => record.details.sessionId === session.id && record.details.runId === run!.id)).toBe(true);
  const fallback = failures.filter(record => record.message === 'Image attempt ended without a result.');
  expect(fallback).toHaveLength(scenario === 'pre-sdk' ? 1 : 0);
  if (scenario !== 'pre-sdk') {
    expect(failures.find(record => record.details.event?.name === 'operation.failed')?.details.event.error).toMatchObject({ code: 'FILE_NOT_FOUND' });
  }
  if (scenario === 'sdk-and-teardown') {
    expect(failures.find(record => record.message === 'Image client teardown failed.')?.details.error).toMatchObject({ code: 'TERMINATION_FAILED' });
    expect(app.queue.state.issue).toMatchObject({ code: 'TERMINATION_FAILED' });
  }
  expect((await app.sessions.get(session.id)).runs[0]?.status).toBe('failed');
});

it('records SDK cancellation once while preserving the cancelled queue outcome', async () => {
  const diagnostics: { message: string; details: Record<string, any> }[] = [];
  outbound.runner = async (_sessionId, _run, events) => {
    await verifyModel(root, manifest, { signal: AbortSignal.abort(), onEvent: events.onEvent, onProgress: events.onProgress });
    return { outcome: refused };
  };
  const app = await Application.open(paths(), undefined, undefined, (_level, message, details) => diagnostics.push({ message, details }));
  const session = await app.sessions.create();
  const [run] = await app.submit(session.id, { ...session.draft, text: 'A bowl' }, 1); await app.queue.settled();
  const terminal = diagnostics.filter(record => record.details.event?.name === 'operation.cancelled');
  expect(terminal).toHaveLength(1);
  expect(terminal[0]?.details).toMatchObject({ sessionId: session.id, runId: run!.id, event: { error: { code: 'CANCELLED' } } });
  expect(diagnostics.filter(record => record.message === 'Image attempt ended without a result.')).toEqual([]);
  expect((await app.sessions.get(session.id)).runs[0]?.status).toBe('cancelled');
});
