import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { PicPatchSdkError } from 'picpatchsdk';
import sharp from 'sharp';
import { Sessions } from '../../src/main/core/sessions.ts';
import { Queue } from '../../src/main/core/queue.ts';
import { heavyRunner } from '../helpers/heavy-runner.ts';
import { until } from '../helpers/until.ts';
let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'picpatch-queue-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
const refusal = { status: 'refused' as const, code: 'OUTPUT_CONFLICT' as const, message: 'Already exists.', subject: '/output', details: {} };
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
  const runner = Object.assign(async () => ({ outcome: { status: 'completed' as const, model: 'fixture', modelRevision: 'fixture', runtime: { name: 'fixture', version: '1' }, seed: 42, references: [], effectiveParameters: {}, image: { path: '/fixture.png', mimeType: 'image/png' as const, size: { width: 1, height: 1 } }, record } }), {
    release: vi.fn(async () => { throw new PicPatchSdkError('TERMINATION_FAILED', 'Worker did not close.', { effect: 'unknown' }); }),
  });
  const queue = new Queue(sessions, runner);
  await queue.submit(session.id, session.draft, 2); await queue.settled();
  const saved = await sessions.get(session.id);
  // The warm worker is closed once, after both runs, and its unconfirmed close stops further work.
  expect(saved.runs.map(run => run.status)).toEqual(['completed', 'completed']); expect(runner.release).toHaveBeenCalledOnce();
  expect(queue.state.issue).toMatchObject({ code: 'TERMINATION_FAILED' });
  await expect(queue.submit(session.id, saved.draft, 1)).rejects.toThrow('termination is unconfirmed');
  expect(saved.runs[0]!.record).toEqual(record);
  expect(queue.state.paused).toBe(true);
  await expect(queue.resume(session.id)).rejects.toThrow('termination is unconfirmed');
});
it('pauses without blocking further work when an idle worker close fails for another reason', async () => {
  const sessions = new Sessions(root); const session = await sessions.create();
  const record = JSON.parse(await readFile(new URL('../fixtures/artifact.json', import.meta.url), 'utf8'));
  const runner = Object.assign(async () => ({ outcome: { status: 'completed' as const, model: 'fixture', modelRevision: 'fixture', runtime: { name: 'fixture', version: '1' }, seed: 42, references: [], effectiveParameters: {}, image: { path: '/fixture.png', mimeType: 'image/png' as const, size: { width: 1, height: 1 } }, record } }), {
    release: vi.fn<() => Promise<void>>().mockRejectedValueOnce(new PicPatchSdkError('CLEANUP_FAILED', 'Private files remained.')).mockResolvedValue(undefined),
  });
  const queue = new Queue(sessions, runner);
  await queue.submit(session.id, session.draft, 1); await queue.settled();
  expect((await sessions.get(session.id)).runs.map(run => run.status)).toEqual(['completed']);
  expect(queue.state).toMatchObject({ paused: true, issue: { code: 'CLEANUP_FAILED' } });
  expect(() => queue.requireIdle('error.conflict')).not.toThrow();
  await queue.resume(session.id); await queue.settled();
  expect(queue.state.paused).toBe(false);
});
it('retains the actual output and pauses after a result metadata write fails', async () => {
  const sessions = new Sessions(root); const session = await sessions.create();
  const record = JSON.parse(await readFile(new URL('../fixtures/artifact.json', import.meta.url), 'utf8'));
  let produced = '';
  const update = sessions.update.bind(sessions); let writes = 0;
  sessions.update = async (...args) => { if (++writes === 3) throw new Error('Disk unavailable'); return update(...args); };
  const queue = new Queue(sessions, async (_id, run) => {
    produced = join(root, session.id, 'outputs', `${run.id}.png`); await writeFile(produced, 'published');
    return { outcome: { status: 'completed' as const, model: 'fixture', modelRevision: 'fixture', runtime: { name: 'fixture', version: '1' }, seed: 42, references: [], effectiveParameters: {}, image: { path: produced, mimeType: 'image/png', size: { width: 1, height: 1 } }, record } };
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
    expect(queue.state.active[0]).toMatchObject({ stage: 'generating', progress: { completed: 2, total: 4 } });
    events.onEvent({ ...event, name: 'operation.stage', stage: 'saving' });
    expect(queue.state.active[0]?.stage).toBe('saving'); expect(queue.state.active[0]?.progress).toBeUndefined();
    return { outcome: refusal };
  });
  await queue.submit(session.id, session.draft, 1); await queue.settled();
  expect((await sessions.get(session.id)).runs[0]!.status).toBe('refused');
});

it('saves the accepted command and pending target atomically, refusing edits of unavailable results', async () => {
  const sessions = new Sessions(root), session = await sessions.create();
  const queue = new Queue(sessions, async () => ({ outcome: refusal })); queue.state.paused = true;
  const [run] = await queue.submit(session.id, { ...session.draft, text: 'Create a quiet garden', seed: 7 }, 1);
  const saved = await new Sessions(root).get(session.id);
  expect(saved.draft).toMatchObject({ text: '', source: run!.id, mode: 'edit', seed: 7 });
  expect(saved.runs[0]!.draft).toMatchObject({ text: 'Create a quiet garden', mode: 'generate' });
  await expect(queue.submit(session.id, { ...saved.draft, text: 'Add a bench' }, 1)).rejects.toThrow('not ready');
  expect((await sessions.get(session.id)).runs).toHaveLength(1);
});

it('branches from the explicit source and restores the target without replaying commands', async () => {
  const sessions = new Sessions(root), session = await sessions.create();
  const record = JSON.parse(await readFile(new URL('../fixtures/artifact.json', import.meta.url), 'utf8'));
  const runner = async () => ({ outcome: { status: 'completed' as const, model: 'fixture', modelRevision: 'fixture', runtime: { name: 'fixture', version: '1' }, seed: 1, references: [], effectiveParameters: {}, image: { path: '/fixture.png', mimeType: 'image/png' as const, size: { width: 1, height: 1 } }, record } });
  const queue = new Queue(sessions, runner);
  const [first] = await queue.submit(session.id, { ...session.draft, text: 'A garden' }, 1); await queue.settled();
  const draft = { ...(await sessions.get(session.id)).draft, text: 'Add a bench' };
  const [second] = await queue.submit(session.id, draft, 1); await queue.settled();
  const [third] = await queue.submit(session.id, { ...draft, text: 'Add a fountain instead' }, 1); await queue.settled();
  const reopened = await new Sessions(root).get(session.id);
  expect(reopened.runs.map(run => run.parent)).toEqual([undefined, first!.id, first!.id]);
  expect(reopened.runs.map(run => run.draft.text)).toEqual(['A garden', 'Add a bench', 'Add a fountain instead']);
  expect(reopened.draft.source).toBe(third!.id);
  expect(reopened.runs[1]!.id).toBe(second!.id);
  const idle = new Queue(new Sessions(root), async () => { throw new Error('Must not replay'); });
  await idle.settled(); expect(idle.state.active).toEqual([]);
});
it('skips a listed run that is no longer queued instead of pausing, and resume never re-lists the active run', async () => {
  const sessions = new Sessions(root); const session = await sessions.create();
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; }); const seen: string[] = [];
  const queue = new Queue(sessions, async (_session, run) => { seen.push(run.id); await held; return { outcome: refusal }; });
  const [first, second] = await queue.submit(session.id, session.draft, 2);
  await until(() => expect(queue.state.active[0]?.runId).toBe(first!.id));
  await sessions.update(session.id, value => { value.runs.find(run => run.id === second!.id)!.status = 'cancelled'; });
  await queue.resume(session.id); release(); await queue.settled();
  expect(seen).toEqual([first!.id]); expect(queue.state.paused).toBe(false); expect(queue.state.issue).toBeUndefined();
});
it('keeps a structured pause reason and blocks resource changes until a stray worker is confirmed gone', async () => {
  const sessions = new Sessions(root); const session = await sessions.create();
  const queue = new Queue(sessions, async () => { throw new PicPatchSdkError('TERMINATION_FAILED', 'Still running.', { effect: 'unknown' }); });
  const [run] = await queue.submit(session.id, session.draft, 1); await queue.settled();
  expect(queue.state.issue).toMatchObject({ code: 'TERMINATION_FAILED' }); expect(queue.busy()).toBe(false);
  expect(() => queue.requireIdle('error.finish_or_cancel_queued_work_before_changing_collections')).toThrow('termination is unconfirmed');
  expect(() => queue.use(new Sessions(root))).toThrow('termination is unconfirmed');
  expect(run).toBeDefined();
});
it('gives a free slot to the open session first, then to the oldest queued run', async () => {
  const sessions = new Sessions(root); const a = await sessions.create(), b = await sessions.create();
  const heavy = heavyRunner(); const queue = new Queue(sessions, heavy.runner);
  const [a1, a2] = await queue.submit(a.id, a.draft, 2);
  const [b1] = await queue.submit(b.id, b.draft, 1);
  const [a3] = await queue.submit(a.id, { ...a.draft, text: 'later' }, 1);
  await until(() => expect(heavy.open()).toEqual([a1!.id]));
  queue.focus(b.id); heavy.finish();
  await until(() => expect(heavy.open()).toEqual([b1!.id]));
  queue.focus(undefined); heavy.finish();
  await until(() => expect(heavy.open()).toEqual([a2!.id])); heavy.finish();
  await until(() => expect(heavy.open()).toEqual([a3!.id])); heavy.finish();
  await queue.settled(); expect(heavy.started).toEqual([a1!.id, b1!.id, a2!.id, a3!.id]); expect(heavy.peak).toBe(1);
});
it('runs up to the concurrency limit, starts more when it rises and cancels one run without touching the others', async () => {
  const sessions = new Sessions(root); const session = await sessions.create();
  let limit = 2; const heavy = heavyRunner(); const queue = new Queue(sessions, heavy.runner, () => {}, () => limit);
  const runs = await queue.submit(session.id, session.draft, 4);
  await until(() => expect(heavy.open()).toHaveLength(2)); expect(queue.state.active.map(item => item.runId)).toEqual(runs.slice(0, 2).map(run => run.id));
  limit = 3; queue.wake();
  await until(() => expect(heavy.open()).toHaveLength(3));
  await queue.cancel(session.id, runs[1]!.id);
  await until(() => expect(heavy.open()).toEqual([runs[0]!.id, runs[2]!.id, runs[3]!.id]));
  for (const run of [runs[0]!, runs[2]!, runs[3]!]) heavy.finish(run.id);
  await queue.settled(); expect(heavy.peak).toBe(3);
  expect((await sessions.get(session.id)).runs.map(run => run.status)).toEqual(['refused', 'cancelled', 'refused', 'refused']);
});
it('lets running work finish when the limit drops and stops everything on quit', async () => {
  const sessions = new Sessions(root); const session = await sessions.create();
  let limit = 2; const heavy = heavyRunner(); const queue = new Queue(sessions, heavy.runner, () => {}, () => limit);
  const runs = await queue.submit(session.id, session.draft, 3);
  await until(() => expect(heavy.open()).toHaveLength(2));
  limit = 1; heavy.finish(runs[0]!.id);
  // A settled run leaves the active list in the same step that fills free slots, so nothing more starts after it.
  await until(() => expect(queue.state.active.map(item => item.runId)).toEqual([runs[1]!.id]));
  expect(heavy.started).toHaveLength(2); expect(heavy.open()).toEqual([runs[1]!.id]);
  heavy.finish(runs[1]!.id); await until(() => expect(heavy.open()).toEqual([runs[2]!.id]));
  await queue.stop(); expect(queue.state.active).toEqual([]);
  expect((await sessions.get(session.id)).runs.map(run => run.status)).toEqual(['refused', 'refused', 'cancelled']);
});
it('moves a session up when a command is submitted, and only then, as a chat list does', async () => {
  const sessions = new Sessions(root); const session = await sessions.create();
  const record = JSON.parse(await readFile(new URL('../fixtures/artifact.json', import.meta.url), 'utf8'));
  const completed = { status: 'completed' as const, model: 'fixture', modelRevision: 'fixture', runtime: { name: 'fixture', version: '1' }, seed: 42, references: [], effectiveParameters: {}, image: { path: '/fixture.png', mimeType: 'image/png' as const, size: { width: 1, height: 1 } }, record };
  let outcome: typeof completed | typeof refusal = refusal;
  const queue = new Queue(sessions, async () => ({ outcome })); queue.state.paused = true;
  // Saved times are to the millisecond, so each step waits for the clock to move on.
  const tick = async () => { const now = Date.now(); await until(() => { if (Date.now() === now) throw new Error('Same millisecond.'); }); };
  await tick(); const [, cancelled] = await queue.submit(session.id, session.draft, 2);
  const submitted = (await sessions.get(session.id)).updated; expect(submitted > session.updated).toBe(true);
  // The refusal, the cancellation, a draft edit, a rename, an import and a mask keep the session where the command put it.
  await tick(); await queue.cancel(session.id, cancelled!.id); await queue.resume(session.id); await queue.settled();
  await tick(); await sessions.update(session.id, value => { value.draft.text = 'Edited'; value.name = 'Renamed'; });
  await sessions.addImage(session.id, 'mask.png', await sharp({ create: { width: 2, height: 2, channels: 3, background: '#fff' } }).png().toBuffer());
  const kept = await sessions.get(session.id);
  expect(kept.runs.map(run => run.status)).toEqual(['refused', 'cancelled']); expect(kept.name).toBe('Renamed'); expect(kept.assets).toHaveLength(1); expect(kept.updated).toBe(submitted);
  // The next command moves it again; its image keeps it there.
  outcome = completed; queue.state.paused = true; await tick(); await queue.submit(session.id, session.draft, 1);
  const resubmitted = (await sessions.get(session.id)).updated; expect(resubmitted > submitted).toBe(true);
  await tick(); await queue.resume(session.id); await queue.settled();
  const imaged = await sessions.get(session.id);
  expect(imaged.runs.at(-1)!.status).toBe('completed'); expect(imaged.updated).toBe(resubmitted);
});

it('retains the primary run failure while separately blocking admission after unconfirmed cleanup', async () => {
  const sessions = new Sessions(root), session = await sessions.create();
  const primary = new PicPatchSdkError('INVALID_REQUEST', 'Inference request failed.');
  const teardown = new PicPatchSdkError('TERMINATION_FAILED', 'Worker termination could not be confirmed.');
  const queue = new Queue(sessions, async (_session, _run, events) => {
    events.onTeardownError(teardown);
    throw primary;
  });
  await queue.submit(session.id, session.draft, 2); await queue.settled();
  const saved = await sessions.get(session.id);
  expect(saved.runs.map(run => run.status)).toEqual(['failed', 'queued']);
  expect(saved.runs[0]!.issue).toEqual({ code: primary.code, effect: primary.effect });
  expect(queue.state.issue).toMatchObject({ code: teardown.code });
  await expect(queue.resume(session.id)).rejects.toThrow('termination is unconfirmed');
  await expect(queue.submit(session.id, session.draft, 1)).rejects.toThrow('termination is unconfirmed');
});
