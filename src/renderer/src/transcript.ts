// The transcript's shape: runs submitted together are one command turn.
import type { Draft, Run, Session } from '../../shared/session.ts';

export interface Turn { id: string; draft: Draft; created: string; runs: Run[] }

/** Consecutive runs from one submission (same time, same captured command) form a turn. */
export function commandTurns(runs: readonly Run[]): Turn[] {
  const turns: Turn[] = [];
  let signature = '';
  for (const run of runs) {
    const current = `${run.created}\n${JSON.stringify(run.draft)}`;
    const last = turns.at(-1);
    if (last && current === signature) last.runs.push(run);
    else turns.push({ id: run.id, draft: run.draft, created: run.created, runs: [run] });
    signature = current;
  }
  return turns;
}

export const pending = (run: Run) => run.status === 'queued' || run.status === 'running';

const numbers = new WeakMap<readonly Run[], Map<string, number>>();

/** Results are numbered by their place in the session, so a number never changes once shown. */
export function imageNumber(session: Session, runId: string): number {
  let index = numbers.get(session.runs);
  if (!index) {
    index = new Map(session.runs.map((run, position) => [run.id, position + 1]));
    numbers.set(session.runs, index);
  }
  return index.get(runId) ?? 0;
}

/** What an image key names in this session: an imported file or a numbered result. */
export function imageLabel(session: Session, key: string, t: (key: string, values?: Record<string, string | number>) => string): string {
  const asset = session.assets.find(item => item.id === key);
  if (asset) return asset.name;
  const number = imageNumber(session, key);
  return number > 0 ? t('conversation.image', { number }) : t('conversation.unavailable');
}
