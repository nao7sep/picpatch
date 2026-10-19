import { randomInt, randomUUID } from 'node:crypto';
import type { ImageOutcome, ProgressEvent, SdkEvent } from 'picpatchsdk';
import type { Draft, Run } from './types.ts';
import { Sessions, validateDraft } from './sessions.ts';

export type RunEvents = { signal: AbortSignal; onProgress: (event: ProgressEvent) => void; onEvent: (event: SdkEvent) => void };
export interface RunCompletion { outcome: ImageOutcome; stopIssue?: string }
export type Runner = (sessionId: string, run: Run, events: RunEvents) => Promise<RunCompletion>;
export interface QueueState { active?: { sessionId: string; runId: string; stage: string; progress?: { completed: number; total: number } }; paused: boolean; issue?: string }
/** One app queue, with no coordination of other processes or apps. */
export class Queue {
  private pending: { sessionId: string; runId: string }[] = [];
  private task: Promise<void> | undefined;
  private terminationUnconfirmed = false;
  private controller: AbortController | undefined;
  state: QueueState = { paused: false };
  constructor(private sessions: Sessions, private run: Runner, private changed: () => void = () => {}) {}
  async submit(sessionId: string, draft: Draft, samples: number, parent?: string): Promise<Run[]> {
    validateDraft(draft);
    if (!Number.isSafeInteger(samples) || samples < 1 || samples > 100 || !draft.modelIds.length) throw new Error('Choose 1–100 samples and at least one model.');
    // The same sample seed across selected models makes the comparison intent visible, not identical noise.
    const seeds = Array.from({ length: samples }, (_, i) => draft.seed === undefined ? randomInt(0, 2 ** 32) : (draft.seed + i) % 2 ** 32);
    const created = new Date().toISOString();
    const runs = seeds.flatMap(seed => draft.modelIds.map(modelId => ({ id: randomUUID(), modelId, seed, draft: structuredClone(draft), ...(parent ? { parent } : {}), status: 'queued' as const, created })));
    await this.sessions.update(sessionId, session => { session.runs.push(...runs); });
    this.pending.push(...runs.map(run => ({ sessionId, runId: run.id })));
    this.changed(); this.start(); return structuredClone(runs);
  }
  async resume(sessionId: string): Promise<void> {
    if (this.terminationUnconfirmed) throw new Error('Worker termination is unconfirmed. Restart PicPatch before starting more work.');
    const session = await this.sessions.get(sessionId);
    for (const run of session.runs) if (run.status === 'queued' && !this.pending.some(item => item.sessionId === sessionId && item.runId === run.id)) this.pending.push({ sessionId, runId: run.id });
    this.state.paused = false; delete this.state.issue; this.start();
  }
  private start(): void {
    if (this.task || this.state.paused) return;
    this.task = this.drain().finally(() => { this.task = undefined; if (this.pending.length && !this.state.paused) this.start(); });
  }
  private async drain(): Promise<void> {
    while (this.pending.length && !this.state.paused) {
      const selected = this.pending.shift()!;
      this.controller = new AbortController();
      this.state.active = { ...selected, stage: 'preparing' }; this.changed();
      try {
        const session = await this.sessions.update(selected.sessionId, value => {
          const run = value.runs.find(r => r.id === selected.runId)!;
          if (run.status !== 'queued') throw new Error('Attempt is no longer queued.');
          run.status = 'running'; run.started = new Date().toISOString();
        });
        const attempt = session.runs.find(r => r.id === selected.runId)!;
        let completion: RunCompletion;
        try {
          completion = await this.run(selected.sessionId, attempt, {
            signal: this.controller.signal,
            onEvent: event => { if (this.state.active) { this.state.active.stage = event.stage; this.changed(); } },
            onProgress: event => { if (this.state.active) { this.state.active.progress = { completed: event.completed, total: event.total }; this.changed(); } },
          });
        } catch (error) {
          const cause = error as { code?: string; kind?: string; effect?: 'none' | 'unknown'; message?: string };
          await this.sessions.update(selected.sessionId, value => {
            const run = value.runs.find(r => r.id === selected.runId)!;
            run.status = cause.kind === 'cancelled' ? 'cancelled' : 'failed'; run.ended = new Date().toISOString();
            run.issue = { code: cause.code ?? 'APP_RUN_FAILED', message: cause.message ?? 'Could not complete the attempt.', effect: cause.effect ?? 'unknown' };
          });
          if (cause.code === 'TERMINATION_FAILED') this.terminationUnconfirmed = true;
          if (cause.code === 'TERMINATION_FAILED' || cause.effect === 'unknown') throw error;
          continue;
        }
        const outcome = completion.outcome;
        await this.sessions.update(selected.sessionId, value => {
          const run = value.runs.find(r => r.id === selected.runId)!; run.ended = new Date().toISOString();
          if ('status' in outcome) { run.status = 'refused'; run.issue = { code: outcome.code, message: outcome.message, effect: outcome.effect }; }
          else { run.status = 'completed'; run.output = `outputs/${run.id}.png`; run.record = outcome.record; }
        });
        if (completion.stopIssue) { this.terminationUnconfirmed = true; throw new Error(completion.stopIssue); }
      } catch (error) {
        // A result may already exist. Never replay a failed metadata write or uncertain process outcome.
        this.state.paused = true; this.state.issue = error instanceof Error ? error.message : 'Queue paused; inspect the affected attempt.';
      } finally { delete this.state.active; this.controller = undefined; this.changed(); }
    }
  }
  async cancel(sessionId: string, runId: string): Promise<void> {
    if (this.state.active?.sessionId === sessionId && this.state.active.runId === runId) { this.controller?.abort(); return; }
    this.pending = this.pending.filter(item => item.sessionId !== sessionId || item.runId !== runId);
    await this.sessions.update(sessionId, session => { const run = session.runs.find(r => r.id === runId); if (run?.status === 'queued') { run.status = 'cancelled'; run.ended = new Date().toISOString(); } });
    this.changed();
  }
  busy(sessionId?: string): boolean { return Boolean(this.state.active && (!sessionId || this.state.active.sessionId === sessionId)) || this.pending.some(item => !sessionId || item.sessionId === sessionId); }
  async stop(): Promise<void> { this.state.paused = true; this.controller?.abort(); await this.task; }
  async settled(): Promise<void> { while (this.task) await this.task; }
}
