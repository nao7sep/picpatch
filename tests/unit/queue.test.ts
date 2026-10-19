import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { beforeEach, afterEach, expect, it } from 'vitest';
import { PicPatchSdkError } from 'picpatchsdk';
import { Sessions } from '../../src/app/sessions.ts';
import { Queue } from '../../src/app/queue.ts';
let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'picpatch-queue-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
const refusal = { status: 'refused' as const, code: 'OUTPUT_CONFLICT' as const, message: 'Already exists.', effect: 'none' as const, subject: '/output', details: {} };
it('captures submissions and processes selected models and seeds serially without changing newer drafts', async () => {
  const sessions = new Sessions(root); const session = await sessions.create();
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  const seen: string[] = []; let active = 0, peak = 0;
  const queue = new Queue(sessions, async (_session, run) => { active++; peak = Math.max(peak, active); seen.push(`${run.modelId}/${run.seed}/${run.draft.text}`); await held; active--; return { outcome: refusal }; });
  const draft = { ...session.draft, text: 'submitted', modelIds: ['first', 'second'], seed: 5 };
  await queue.submit(session.id, draft, 2); draft.text = 'mutated';
  await sessions.update(session.id, value => { value.draft.text = 'new draft'; }); release(); await queue.settled();
  expect(peak).toBe(1); expect(seen).toEqual(['first/5/submitted', 'second/5/submitted', 'first/6/submitted', 'second/6/submitted']);
  expect((await sessions.get(session.id)).draft.text).toBe('new draft');
});
it('cancels active work, preserves independent queued work and never retries uncertainty', async () => {
  const sessions = new Sessions(root); const session = await sessions.create(); let entered!: () => void; const ready = new Promise<void>(r => { entered = r; });
  const queue = new Queue(sessions, async (_session, _run, events) => { entered(); await new Promise<void>(resolve => events.signal.addEventListener('abort', () => resolve(), { once: true })); throw new PicPatchSdkError('CANCELLED', 'Stopped.'); });
  const runs = await queue.submit(session.id, session.draft, 2); await ready; await queue.cancel(session.id, runs[1]!.id); await queue.cancel(session.id, runs[0]!.id); await queue.settled();
  expect((await sessions.get(session.id)).runs.map(r => r.status)).toEqual(['cancelled', 'cancelled']);
  const uncertain = new Queue(sessions, async () => { throw new PicPatchSdkError('TERMINATION_FAILED', 'Still running.', { effect: 'unknown' }); });
  await uncertain.submit(session.id, session.draft, 2); await uncertain.settled();
  expect(uncertain.state.paused).toBe(true); await expect(uncertain.resume(session.id)).rejects.toThrow('termination is unconfirmed'); expect((await sessions.get(session.id)).runs.slice(-2).map(r => r.status)).toEqual(['failed', 'queued']);
});
it('reopens interrupted attempts without executing or overwriting their retained output', async () => {
  const sessions = new Sessions(root); const session = await sessions.create();
  const queue = new Queue(sessions, async () => ({ outcome: refusal })); queue.state.paused = true;
  const [run] = await queue.submit(session.id, session.draft, 1);
  await sessions.update(session.id, s => { s.runs[0]!.status = 'running'; });
  const output = join(root, session.id, 'outputs', `${run!.id}.png`); await writeFile(output, 'retained');
  const reopened = await new Sessions(root).get(session.id); expect(reopened.runs[0]!.status).toBe('interrupted');
  expect(await readFile(output, 'utf8')).toBe('retained');
});
it('keeps a published result when worker cleanup cannot be confirmed', async () => {
  const sessions = new Sessions(root); const session = await sessions.create();
  const record = JSON.parse(await readFile(new URL('../fixtures/artifact.json', import.meta.url), 'utf8'));
  const queue = new Queue(sessions, async () => ({ outcome: { model: 'fixture', modelRevision: 'fixture', runtime: { name: 'fixture', version: '1' }, seed: 42, references: [], effectiveParameters: {}, image: { path: '/fixture.png', mimeType: 'image/png', size: { width: 1, height: 1 } }, record }, stopIssue: 'Worker did not close.' }));
  await queue.submit(session.id, session.draft, 2); await queue.settled();
  const saved = await sessions.get(session.id);
  expect(saved.runs.map(run => run.status)).toEqual(['completed', 'queued']);
  expect(saved.runs[0]!.record).toEqual(record);
  expect(queue.state.paused).toBe(true);
  await expect(queue.resume(session.id)).rejects.toThrow('termination is unconfirmed');
});
it('retains the actual output and pauses after a result metadata write fails', async () => {
  const sessions = new Sessions(root); const session = await sessions.create();
  const record = JSON.parse(await readFile(new URL('../fixtures/artifact.json', import.meta.url), 'utf8'));
  let produced = '';
  const update = sessions.update.bind(sessions); let writes = 0;
  sessions.update = async (...args) => { if (++writes === 3) throw new Error('Disk unavailable'); return update(...args); };
  const queue = new Queue(sessions, async (_id, run) => {
    produced = join(root, session.id, 'outputs', `${run.id}.png`); await writeFile(produced, 'published');
    return { outcome: { model: 'fixture', modelRevision: 'fixture', runtime: { name: 'fixture', version: '1' }, seed: 42, references: [], effectiveParameters: {}, image: { path: produced, mimeType: 'image/png', size: { width: 1, height: 1 } }, record } };
  });
  await queue.submit(session.id, session.draft, 2); await queue.settled();
  expect(queue.state.paused).toBe(true); expect(await readFile(produced, 'utf8')).toBe('published');
  expect((await new Sessions(root).get(session.id)).runs.map(run => run.status)).toEqual(['interrupted', 'queued']);
});

it('keeps diagnostic events separate from stage and progress display', async () => {
  const sessions = new Sessions(root); const session = await sessions.create();
  const queue = new Queue(sessions, async (_session, _run, events) => {
    const event = { type: 'event' as const, operationId: 'fixture', verb: 'generate', time: new Date().toISOString(), level: 'info' as const, message: 'Stage changed.' };
    events.onProgress({ type: 'progress', stage: 'generating', completed: 2, total: 4 });
    events.onEvent({ ...event, name: 'hook.failed', stage: 'hook-failed' });
    expect(queue.state.active).toMatchObject({ stage: 'generating', progress: { completed: 2, total: 4 } });
    events.onEvent({ ...event, name: 'operation.stage', stage: 'saving' });
    expect(queue.state.active?.stage).toBe('saving'); expect(queue.state.active?.progress).toBeUndefined();
    return { outcome: refusal };
  });
  await queue.submit(session.id, session.draft, 1); await queue.settled();
  expect((await sessions.get(session.id)).runs[0]!.status).toBe('refused');
});
