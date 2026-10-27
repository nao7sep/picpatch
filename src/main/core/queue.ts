import { UiError } from '../../shared/i18n/index.ts';
import type { Key, Message } from '../../shared/i18n/index.ts';
import { performance } from 'node:perf_hooks';
import { randomInt, randomUUID } from 'node:crypto';
import type { ImageOutcome, ModelOpenRefusal, ProgressEvent, SdkEvent } from 'picpatchsdk';
import type { Draft, Run, QueueState } from '../../shared/session.ts';
export type { QueueState } from '../../shared/session.ts';
import { Sessions, validateDraft } from './sessions.ts';
import { afterCommand, commandTargetReady, imageCommand, recoverCommand } from '../../shared/image-command.ts';

export type RunEvents = { signal: AbortSignal; onProgress: (event: ProgressEvent) => void; onEvent: (event: SdkEvent) => void; onTeardownError: (error: unknown) => void };
export interface RunCompletion { outcome: ImageOutcome | ModelOpenRefusal }
/** `release` closes any worker kept warm between runs; the queue calls it whenever it goes idle. */
export type Runner = ((sessionId: string, run: Run, events: RunEvents) => Promise<RunCompletion>) & { release?: () => Promise<void> };
/**
 * One app queue, with no coordination of other processes or apps. Up to `limit()` runs execute at once
 * (default 1). A free slot takes the oldest queued run of the open session, otherwise the oldest queued run.
 */
export class Queue {
  private pending: { sessionId: string; runId: string }[] = [];
  private running = new Map<string, { controller: AbortController; task: Promise<void> }>();
  private terminationUnconfirmed = false;
  private releasing: Promise<void> = Promise.resolve();
  private releasingCount = 0;
  private focused: string | undefined;
  private starts = new Map<string, number>();
  snapshot(): QueueState {
    const now = performance.now();
    return structuredClone({ ...this.state, active: this.state.active.map(item => ({ ...item, elapsedMs: Math.max(0, now - (this.starts.get(item.runId) ?? now)) })) });
  }
  state: QueueState = { paused: false, active: [] };
  /** `changed('progress')` reports only active runs' stage and progress, so listeners need not reload sessions. */
  constructor(private sessions: Sessions, private run: Runner, private changed: (scope?: 'progress') => void = () => {}, private limit: () => number = () => 1) {}
  /** One queue outlives collection switches so an unconfirmed worker stop keeps blocking new work. */
  use(sessions: Sessions): void { this.requireIdle('error.finish_or_cancel_queued_work_before_changing_collections'); this.sessions = sessions; this.focused = undefined; }
  /** The session the user has open; its queued runs take the next free slot. */
  focus(sessionId: string | undefined): void { this.focused = sessionId; }
  async submit(sessionId: string, draft: Draft, samples: number): Promise<Run[]> {
    if (this.terminationUnconfirmed) throw new UiError('error.worker_termination_is_unconfirmed_restart_picpatch_before_starting_more_work');
    draft = imageCommand(validateDraft(draft));
    if (!Number.isSafeInteger(samples) || samples < 1 || samples > 100 || !draft.modelIds.length) throw new UiError('error.choose_1100_samples_and_at_least_one_model');
    // The same sample seed across selected models makes the comparison intent visible, not identical noise.
    const seeds = Array.from({ length: samples }, (_, i) => draft.seed === undefined ? randomInt(0, 2 ** 32) : (draft.seed + i) % 2 ** 32);
    const created = new Date().toISOString();
    const runs: Run[] = seeds.flatMap(seed => draft.modelIds.map(modelId => ({ id: randomUUID(), modelId, seed, draft: structuredClone(draft), status: 'queued' as const, created })));
    await this.sessions.update(sessionId, session => {
      if (!commandTargetReady(session, draft)) throw new UiError('conversation.waiting');
      const parent = session.runs.find(run => run.id === draft.source && run.output)?.id;
      // Provenance: which earlier result this command edited.
      if (parent) runs.forEach(run => { run.parent = parent; });
      session.runs.push(...runs);
      session.draft = afterCommand(draft, runs[0]!.id);
    }, true);
    this.pending.push(...runs.map(run => ({ sessionId, runId: run.id })));
    this.changed(); this.wake(); return structuredClone(runs);
  }
  async resume(sessionId: string): Promise<void> {
    if (this.terminationUnconfirmed) throw new UiError('error.worker_termination_is_unconfirmed_restart_picpatch_before_starting_more_work');
    const session = await this.sessions.get(sessionId);
    const waiting = (runId: string) => this.running.has(runId) || this.pending.some(item => item.sessionId === sessionId && item.runId === runId);
    for (const run of session.runs) if (run.status === 'queued' && !waiting(run.id)) this.pending.push({ sessionId, runId: run.id });
    this.state.paused = false; delete this.state.issue; this.wake();
  }
  /** Fills free slots; called after every change that can free or add work, including a new limit. */
  wake(): void {
    while (!this.state.paused && !this.terminationUnconfirmed && this.pending.length && this.running.size < Math.max(1, this.limit())) {
      const index = Math.max(0, this.pending.findIndex(item => item.sessionId === this.focused));
      this.launch(this.pending.splice(index, 1)[0]!);
    }
    if (!this.running.size) this.idle();
  }
  private launch(selected: { sessionId: string; runId: string }): void {
    const controller = new AbortController();
    const unpin = this.sessions.pin(selected.sessionId);
    const active = { ...selected, stage: 'preparing', startedAt: Date.now(), elapsedMs: 0 } as QueueState['active'][number];
    this.starts.set(selected.runId, performance.now());
    this.state.active.push(active); this.changed();
    const task = this.execute(selected, controller.signal, active).finally(() => {
      unpin(); this.starts.delete(selected.runId);
      this.running.delete(selected.runId); this.state.active = this.state.active.filter(item => item !== active);
      this.changed(); this.wake();
    });
    this.running.set(selected.runId, { controller, task });
  }
  /** A warm worker is closed once nothing is running; an unconfirmed close blocks further work. */
  private idle(): void {
    if (!this.run.release) return;
    this.releasingCount++;
    this.releasing = this.releasing.then(() => this.run.release!()).catch(error => this.halt(error)).finally(() => { this.releasingCount--; });
  }
  /** Teardown trouble has its own outcome: it pauses the queue, and an unconfirmed stop blocks further work. */
  private halt(error: unknown): void {
    if ((error as { code?: string }).code === 'TERMINATION_FAILED') this.terminationUnconfirmed = true;
    this.state.paused = true; this.state.issue = queueIssue(error); this.changed();
  }
  private async execute(selected: { sessionId: string; runId: string }, signal: AbortSignal, active: QueueState['active'][number]): Promise<void> {
    const started = performance.now();
    const progressChanged = () => { active.elapsedMs = performance.now() - started; this.changed('progress'); };
    try {
      // A run cancelled or already taken since it was listed is simply skipped.
      let taken = false;
      const session = await this.sessions.update(selected.sessionId, value => {
        const run = value.runs.find(r => r.id === selected.runId);
        if (run?.status === 'queued') { run.status = 'running'; run.started = new Date().toISOString(); taken = true; }
      });
      const attempt = session.runs.find(r => r.id === selected.runId);
      if (!taken || !attempt) return;
      let completion: RunCompletion;
      try {
        completion = await this.run(selected.sessionId, attempt, {
          signal,
          // A published image or primary error remains the run's result.
          onTeardownError: error => this.halt(error),
          onEvent: event => { if (event.name === 'operation.stage') { if (active.stage !== event.stage) delete active.progress; active.stage = event.stage; progressChanged(); } },
          onProgress: event => { active.stage = event.stage; active.progress = { completed: event.completed, total: event.total }; progressChanged(); },
        });
      } catch (error) {
        const cause = error as { code?: string; kind?: string; effect?: 'none' | 'unknown'; message?: string };
        await this.sessions.update(selected.sessionId, value => {
          const run = value.runs.find(r => r.id === selected.runId)!;
          run.status = cause.kind === 'cancelled' ? 'cancelled' : 'failed'; run.ended = new Date().toISOString();
          run.issue = { code: cause.code ?? 'APP_RUN_FAILED', message: cause.message ?? 'Could not complete the attempt.', effect: cause.effect ?? 'unknown' };
          value.draft = recoverCommand(value.draft, value.runs);
        });
        if (cause.code === 'TERMINATION_FAILED') this.terminationUnconfirmed = true;
        if (cause.code === 'TERMINATION_FAILED' || cause.effect === 'unknown') throw error;
        return;
      }
      const outcome = completion.outcome;
      await this.sessions.update(selected.sessionId, value => {
        const run = value.runs.find(r => r.id === selected.runId)!; run.ended = new Date().toISOString();
        if (outcome.status === 'refused') { run.status = 'refused'; run.issue = { code: outcome.code, message: outcome.message }; }
        else {
          run.status = 'completed'; run.output = `outputs/${run.id}.png`; run.record = outcome.record;
          const notices: NonNullable<Run['notices']> = [];
          if (outcome.sidecar?.status === 'failed') notices.push({ notice: { key: 'ui.image_saved_its_settings_sidecar_could_not_be_saved' } });
          if (outcome.cleanupWarning) notices.push({ code: 'CLEANUP_FAILED' });
          if (notices.length) run.notices = notices;
        }
        value.draft = recoverCommand(value.draft, value.runs);
      });
    } catch (error) {
      // A result may already exist. Never replay a failed metadata write or uncertain process outcome.
      this.state.paused = true; this.state.issue = queueIssue(error);
    }
  }
  async cancel(sessionId: string, runId: string): Promise<void> {
    const running = this.running.get(runId);
    if (running) { running.controller.abort(); return; }
    this.pending = this.pending.filter(item => item.sessionId !== sessionId || item.runId !== runId);
    await this.sessions.update(sessionId, session => { const run = session.runs.find(r => r.id === runId); if (run?.status === 'queued') { run.status = 'cancelled'; run.ended = new Date().toISOString(); session.draft = recoverCommand(session.draft, session.runs); } });
    this.changed();
  }
  /** Resource changes wait for queued work and for a confirmed worker stop. */
  requireIdle(reason: Key): void {
    if (this.terminationUnconfirmed) throw new UiError('error.worker_termination_is_unconfirmed_restart_picpatch_before_starting_more_work');
    if (this.busy() || this.releasingCount) throw new UiError(reason);
  }
  busy(sessionId?: string): boolean { return this.state.active.some(item => !sessionId || item.sessionId === sessionId) || this.pending.some(item => !sessionId || item.sessionId === sessionId); }
  async stop(): Promise<void> { this.state.paused = true; for (const { controller } of this.running.values()) controller.abort(); await this.settled(); }
  async settled(): Promise<void> {
    while (this.running.size) await Promise.all([...this.running.values()].map(item => item.task));
    await this.releasing;
  }
}
function queueIssue(error: unknown): NonNullable<QueueState['issue']> {
  const cause = error as { code?: unknown; message?: unknown; notice?: Message };
  return { message: typeof cause?.message === 'string' ? cause.message : 'Queue paused; inspect the affected attempt.', ...(typeof cause?.code === 'string' ? { code: cause.code } : {}), ...(cause?.notice ? { notice: cause.notice } : {}) };
}
