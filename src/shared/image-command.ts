import type { Draft, Run, Session } from '../app/types.ts';

/** The visible inputs choose the operation; command text is never interpreted or rewritten. */
export function imageCommand(draft: Draft): Draft {
  return { ...draft, mode: draft.source || draft.references.length || draft.mask || draft.outpaint ? 'edit' : 'generate' };
}

export function targetImage(draft: Draft, source: string): Draft {
  const next = imageCommand({ ...draft, source });
  if (source !== draft.source) { delete next.mask; delete next.outpaint; }
  return next;
}

export function newImage(draft: Draft): Draft {
  const next = structuredClone(draft);
  delete next.source; delete next.mask; delete next.outpaint;
  next.references = [];
  return imageCommand(next);
}

export function hasImage(session: Session, key: string): boolean {
  return session.assets.some(asset => asset.id === key) || session.runs.some(run => run.id === key && Boolean(run.output));
}

export function commandTargetReady(session: Session, draft = session.draft): boolean {
  return !draft.source || hasImage(session, draft.source);
}

/** A pending result is an explicit target, never an implicit queued dependency. */
export function afterCommand(draft: Draft, result: string): Draft {
  return targetImage({ ...draft, text: '' }, result);
}

/** A terminal attempt cannot remain a pending source. Preserve newer composer edits. */
export function recoverCommand(draft: Draft, runs: readonly Run[]): Draft {
  const run = runs.find(item => item.id === draft.source);
  if (!run || run.output || !['failed', 'refused', 'cancelled', 'interrupted'].includes(run.status)) return draft;
  const pending = afterCommand(run.draft, run.id);
  if (JSON.stringify(draft) === JSON.stringify(pending)) return structuredClone(run.draft);
  const next = { ...draft, text: draft.text || run.draft.text };
  if (run.draft.source) next.source = run.draft.source; else delete next.source;
  return imageCommand(next);
}
