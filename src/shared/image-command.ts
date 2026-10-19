import type { Draft, Session } from '../app/types.ts';

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
