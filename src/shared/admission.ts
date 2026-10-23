import { t, term } from './i18n/index.ts';
import { admissionIssues, type AdmissionIssue, type ModelCapabilities } from 'picpatchsdk/types';
import { commandGeometry } from './image-command.ts';
import type { Draft } from './session.ts';
/** The SDK's own admission rules, presented in the window's copy. The SDK remains authoritative at execution; a draft is never rewritten. */
export function incompatibilities(draft: Draft, capabilities: ModelCapabilities): string[] {
  const issues = admissionIssues({
    operation: draft.mode, text: draft.text,
    sourceImage: draft.source !== undefined, maskImage: draft.mask !== undefined,
    ...commandGeometry(draft, capabilities.maskMode),
    references: draft.references.map(group => ({ id: group.id, role: group.role, ...(group.conditioning ? { conditioning: group.conditioning } : {}), ...(group.className !== undefined ? { className: group.className } : {}), images: group.images.length })),
    parameters: draft.parameters,
    ...(draft.control ? { control: { kind: draft.control.kind } } : {}),
  }, capabilities);
  return [...new Set(issues.map(issue => copy(issue, draft)))];
}
function copy(issue: AdmissionIssue, draft: Draft): string {
  const group = draft.references.find(item => item.id === issue.subject);
  switch (issue.code) {
    case 'GENERATION_UNSUPPORTED': return t('ui.textonly_generation_is_unavailable');
    case 'EDITING_UNSUPPORTED': return t('ui.editing_is_unavailable');
    case 'SOURCE_REQUIRED': return t('ui.add_a_source_image');
    case 'MASK_REQUIRED': return t('ui.paint_a_mask_or_expand_the_canvas');
    case 'MASK_UNSUPPORTED': return t('ui.masks_are_unavailable');
    case 'OUTPAINT_UNSUPPORTED': return t('ui.canvas_expansion_is_unavailable');
    case 'CONTROL_UNSUPPORTED': return t('ui.a_matching_control_model_is_required');
    case 'REFERENCE_ROLE_UNSUPPORTED': return group ? t('admission.role', { name: group.id, role: term('role', group.role) }) : t('error.input');
    case 'REFERENCE_CONDITIONING_UNSUPPORTED': return group ? t('admission.conditioning', { name: group.id, method: term('conditioning', group.conditioning ?? 'prompt') }) : t('error.input');
    case 'REFERENCE_IMAGES_REQUIRED': return t('admission.photo', { name: issue.subject ?? '' });
    case 'REFERENCE_CLASS_REQUIRED': return t('admission.class', { name: issue.subject ?? '' });
    case 'REFERENCE_PLACEHOLDER': return t('admission.independent', { reference: issue.subject ?? '' });
    case 'REFERENCE_LIMIT': return t('admission.limit');
    case 'PARAMETER_UNSUPPORTED': return t('admission.parameter', { name: term('parameter', issue.subject ?? '') });
    case 'PARAMETER_OUT_OF_RANGE': return t('admission.value', { name: term('parameter', issue.subject ?? '') });
    case 'STRENGTH_REQUIRES_SOURCE': return t('admission.strength', { name: term('parameter', 'strength') });
    case 'SIZE_UNSUPPORTED': return t('admission.size');
    case 'GENERATION_INPUTS': return t('error.input');
  }
}
