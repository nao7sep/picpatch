// A stand-in for a slow image engine: every run stays open until the test finishes it, so
// scheduling, concurrency and cancellation can be checked without models or memory.
import type { Runner } from '../../src/main/core/queue.ts';
const refusal = { status: 'refused' as const, code: 'OUTPUT_CONFLICT' as const, message: 'Dummy result.', subject: '/output', details: {} };
export function heavyRunner() {
  const open = new Map<string, () => void>();
  const started: string[] = []; let active = 0, peak = 0;
  const runner: Runner = Object.assign(async (_sessionId: string, run: { id: string }, events: { signal: AbortSignal }) => {
    started.push(run.id); active++; peak = Math.max(peak, active);
    try {
      await new Promise<void>((resolve, reject) => {
        open.set(run.id, resolve);
        events.signal.addEventListener('abort', () => reject(Object.assign(new Error('Stopped.'), { kind: 'cancelled', code: 'CANCELLED', effect: 'none' })), { once: true });
      });
      return { outcome: refusal };
    } finally { active--; open.delete(run.id); }
  }, { release: async () => {} });
  return {
    runner, started, get active() { return active; }, get peak() { return peak; },
    /** Lets one run, or the oldest open one, finish. */
    finish(runId = [...open.keys()][0]!) { open.get(runId)!(); },
    open: () => [...open.keys()],
  };
}
