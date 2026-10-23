import type { ImageSize, ModelCapabilities, OutpaintCanvas } from 'picpatchsdk/types';
import type { Draft, Run, Session } from './session.ts';

/** The visible inputs choose the operation; command text is never interpreted or rewritten. */
export function imageCommand(draft: Draft): Draft {
  return { ...draft, mode: draft.source || draft.references.length || draft.mask || draft.outpaint ? 'edit' : 'generate' };
}

/** Expansion owns its output size; composited masks preserve the oriented source size chosen by the SDK. */
export function commandGeometry(draft: Draft, maskMode: ModelCapabilities['maskMode'] | undefined): { size?: ImageSize; outpaint?: OutpaintCanvas } {
  if (draft.mode === 'edit' && draft.outpaint) {
    const size = { width: draft.outpaint.width, height: draft.outpaint.height };
    return { size, outpaint: { size, left: draft.outpaint.left, top: draft.outpaint.top } };
  }
  if (draft.mode === 'edit' && draft.source && draft.mask && (maskMode === 'composite' || maskMode === 'latent-composite')) return {};
  return { size: { width: draft.width, height: draft.height } };
}

export function targetImage(draft: Draft, source: string): Draft {
  const next = imageCommand({ ...draft, source });
  if (source !== draft.source) { delete next.mask; delete next.outpaint; }
  return next;
}

/** Removes the image being edited and what belongs to it, keeping references and options. */
export function withoutTarget(draft: Draft): Draft {
  const next = structuredClone(draft);
  delete next.source; delete next.mask; delete next.outpaint;
  return imageCommand(next);
}

export function hasImage(session: Session, key: string): boolean {
  return session.assets.some(asset => asset.id === key) || session.runs.some(run => run.id === key && Boolean(run.output));
}

/** A mask is painted on an image that exists, for a model that takes masks; a result still being made is not one yet. */
export function canPaintMask(session: Session, draft: Draft, maskMode: ModelCapabilities['maskMode'] | undefined): boolean {
  return draft.source !== undefined && hasImage(session, draft.source) && maskMode !== undefined && maskMode !== 'none';
}

/** What a painted mask keeps outside the edited region with this model. */
export function maskNote(maskMode: ModelCapabilities['maskMode'] | undefined): 'ui.native_inpainting_pixels_outside_the_mask_may_change' | 'ui.masked_edits_preserve_normalized_pixels_outside_the_edited_region' | 'ui.this_model_does_not_support_masks' {
  if (maskMode === 'native') return 'ui.native_inpainting_pixels_outside_the_mask_may_change';
  return maskMode === 'composite' || maskMode === 'latent-composite' ? 'ui.masked_edits_preserve_normalized_pixels_outside_the_edited_region' : 'ui.this_model_does_not_support_masks';
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
