import { UiError } from '../../shared/i18n/index.ts';
import type { Key, Message } from '../../shared/i18n/index.ts';
import { randomInt, randomUUID } from 'node:crypto';
import type { ImageOutcome, ProgressEvent, SdkEvent } from 'picpatchsdk';
import type { Draft, Run, QueueState } from '../../shared/session.ts';
export type { QueueState } from '../../shared/session.ts';
import { Sessions, validateDraft } from './sessions.ts';
import { afterCommand, commandTargetReady, imageCommand, recoverCommand } from '../../shared/image-command.ts';

export type RunEvents = { signal: AbortSignal; onProgress: (event: ProgressEvent) => void; onEvent: (event: SdkEvent) => void };
export interface RunCompletion { outcome: ImageOutcome }
/** `release` closes any worker kept warm between runs; the queue calls it whenever it goes idle. */
export type Runner = ((sessionId: string, run: Run, events: RunEvents) => Promise<RunCompletion>) & { release?: () => Promise<void> };
/** One app queue, with no coordination of other processes or apps. */
export class Queue {
  private pending: { sessionId: string; runId: string }[] = [];
  private task: Promise<void> | undefined;
  private terminationUnconfirmed = false;
  private controller: AbortController | undefined;
  private releasing: Promise<void> = Promise.resolve();
  state: QueueState = { paused: false };
  /** `changed('progress')` reports only the active run's stage and progress, so listeners need not reload sessions. */
  constructor(private sessions: Sessions, private run: Runner, private changed: (scope?: 'progress') => void = () => {}) {}
  /** One queue outlives collection switches so an unconfirmed worker stop keeps blocking new work. */
  use(sessions: Sessions): void { this.requireIdle('error.finish_or_cancel_queued_work_before_changing_collections'); this.sessions = sessions; }
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
    });
    this.pending.push(...runs.map(run => ({ sessionId, runId: run.id })));
    this.changed(); this.start(); return structuredClone(runs);
  }
  async resume(sessionId: string): Promise<void> {
    if (this.terminationUnconfirmed) throw new UiError('error.worker_termination_is_unconfirmed_restart_picpatch_before_starting_more_work');
    const session = await this.sessions.get(sessionId);
    const waiting = (runId: string) => (this.state.active?.sessionId === sessionId && this.state.active.runId === runId) || this.pending.some(item => item.sessionId === sessionId && item.runId === runId);
    for (const run of session.runs) if (run.status === 'queued' && !waiting(run.id)) this.pending.push({ sessionId, runId: run.id });
    this.state.paused = false; delete this.state.issue; this.start();
  }
  private start(): void {
    if (this.task || this.state.paused) return;
    this.task = this.drain().finally(() => { this.task = undefined; if (this.pending.length && !this.state.paused) this.start(); else this.idle(); });
  }
  /** A warm worker is closed once nothing is left to run; an unconfirmed close blocks further work. */
  private idle(): void {
    if (!this.run.release) return;
    this.releasing = this.releasing.then(() => this.run.release!()).catch(error => {
      this.terminationUnconfirmed = true; this.state.paused = true; this.state.issue = queueIssue(error); this.changed();
    });
  }
  private async drain(): Promise<void> {
    while (this.pending.length && !this.state.paused) {
      const selected = this.pending.shift()!;
      this.controller = new AbortController();
      this.state.active = { ...selected, stage: 'preparing', startedAt: Date.now() }; this.changed();
      try {
        // A run cancelled or already taken since it was listed is simply skipped.
        let taken = false;
        const session = await this.sessions.update(selected.sessionId, value => {
          const run = value.runs.find(r => r.id === selected.runId);
          if (run?.status === 'queued') { run.status = 'running'; run.started = new Date().toISOString(); taken = true; }
        });
        const attempt = session.runs.find(r => r.id === selected.runId);
        if (!taken || !attempt) continue;
        let completion: RunCompletion;
        try {
          completion = await this.run(selected.sessionId, attempt, {
            signal: this.controller.signal,
            onEvent: event => { if (this.state.active && event.name === 'operation.stage') { if (this.state.active.stage !== event.stage) delete this.state.active.progress; this.state.active.stage = event.stage; this.changed('progress'); } },
            onProgress: event => { if (this.state.active) { this.state.active.stage = event.stage; this.state.active.progress = { completed: event.completed, total: event.total }; this.changed('progress'); } },
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
          continue;
        }
        const outcome = completion.outcome;
        await this.sessions.update(selected.sessionId, value => {
          const run = value.runs.find(r => r.id === selected.runId)!; run.ended = new Date().toISOString();
          if ('status' in outcome) { run.status = 'refused'; run.issue = { code: outcome.code, message: outcome.message, effect: outcome.effect }; }
          else { run.status = 'completed'; run.output = `outputs/${run.id}.png`; run.record = outcome.record; const notices = [outcome.sidecar?.status === 'failed' ? { notice: { key: 'ui.image_saved_its_settings_sidecar_could_not_be_saved' } } : undefined, outcome.cleanupWarning ? { code: 'CLEANUP_FAILED' } : undefined].filter(value => value !== undefined); if (notices.length) run.notices = notices; }
          value.draft = recoverCommand(value.draft, value.runs);
        });
      } catch (error) {
        // A result may already exist. Never replay a failed metadata write or uncertain process outcome.
        this.state.paused = true; this.state.issue = queueIssue(error);
      } finally { delete this.state.active; this.controller = undefined; this.changed(); }
    }
  }
  async cancel(sessionId: string, runId: string): Promise<void> {
    if (this.state.active?.sessionId === sessionId && this.state.active.runId === runId) { this.controller?.abort(); return; }
    this.pending = this.pending.filter(item => item.sessionId !== sessionId || item.runId !== runId);
    await this.sessions.update(sessionId, session => { const run = session.runs.find(r => r.id === runId); if (run?.status === 'queued') { run.status = 'cancelled'; run.ended = new Date().toISOString(); session.draft = recoverCommand(session.draft, session.runs); } });
    this.changed();
  }
  /** Resource changes wait for queued work and for a confirmed worker stop. */
  requireIdle(reason: Key): void {
    if (this.terminationUnconfirmed) throw new UiError('error.worker_termination_is_unconfirmed_restart_picpatch_before_starting_more_work');
    if (this.busy()) throw new UiError(reason);
  }
  busy(sessionId?: string): boolean { return Boolean(this.state.active && (!sessionId || this.state.active.sessionId === sessionId)) || this.pending.some(item => !sessionId || item.sessionId === sessionId); }
  async stop(): Promise<void> { this.state.paused = true; this.controller?.abort(); await this.task; await this.releasing; }
  async settled(): Promise<void> { while (this.task) await this.task; await this.releasing; }
}
function queueIssue(error: unknown): NonNullable<QueueState['issue']> {
  const cause = error as { code?: unknown; message?: unknown; notice?: Message };
  return { message: typeof cause?.message === 'string' ? cause.message : 'Queue paused; inspect the affected attempt.', ...(typeof cause?.code === 'string' ? { code: cause.code } : {}), ...(cause?.notice ? { notice: cause.notice } : {}) };
}
