import { t, term } from './i18n/index.ts';
import type { ModelCapabilities } from 'picpatchsdk/types';
import type { Draft } from './session.ts';
/** Early GUI explanations; the SDK remains authoritative at execution. Never rewrite a draft. */
export function incompatibilities(draft: Draft, capabilities: ModelCapabilities): string[] {
  const issues: string[] = [];
  if (draft.mode === 'generate') {
    if (!capabilities.textToImage) issues.push(t('ui.textonly_generation_is_unavailable'));
    if (draft.source || draft.mask || draft.references.length || draft.outpaint) issues.push(t('error.input'));
  } else {
    if (!capabilities.instructionEditing) issues.push(t('ui.editing_is_unavailable'));
    if (capabilities.sourceImageRequired && !draft.source) issues.push(t('ui.add_a_source_image'));
    if (capabilities.maskRequired && !draft.mask && !draft.outpaint) issues.push(t('ui.paint_a_mask_or_expand_the_canvas'));
    if (draft.mask && capabilities.maskMode === 'none') issues.push(t('ui.masks_are_unavailable'));
    if (draft.outpaint && !capabilities.outpainting) issues.push(t('ui.canvas_expansion_is_unavailable'));
    for (const group of draft.references) {
      if (!capabilities.referenceRoles.includes(group.role)) issues.push(t('admission.role', { name: group.id, role: term('role', group.role) }));
      const method = group.conditioning ?? 'prompt';
      const required = { prompt: 'ordered-images-with-role-prompt', identity: 'pooled-identity', appearance: 'appearance-embedding' }[method];
      if (capabilities.referenceConditioning !== required && !(method === 'identity' && capabilities.referenceConditioning === 'independent-subject')) issues.push(t('admission.conditioning', { name: group.id, method: term('conditioning', method) }));
      if (!group.images.length) issues.push(t('admission.photo', { name: group.id }));
      if (method === 'identity' && capabilities.referenceConditioning !== 'independent-subject' && !group.className) issues.push(t('admission.class', { name: group.id }));
    }
  }
  for (const key of Object.keys(draft.parameters)) {
    if (!Object.hasOwn(capabilities.parameters ?? {}, key)) issues.push(t('admission.parameter', { name: term('parameter', key) }));
  }
  if (draft.control && !capabilities.controlKinds?.includes(draft.control.kind)) issues.push(t('ui.a_matching_control_model_is_required'));
  return issues;
}
