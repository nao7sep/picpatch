import type { ModelCapabilities } from 'picpatchsdk/types';
import type { Draft } from '../app/types.ts';
/** Early GUI explanations; the SDK remains authoritative at execution. Never rewrite a draft. */
export function incompatibilities(draft: Draft, capabilities: ModelCapabilities): string[] {
  const issues: string[] = [];
  if (draft.mode === 'generate') {
    if (!capabilities.textToImage) issues.push('Text-only generation is unavailable.');
    if (draft.source || draft.mask || draft.references.length || draft.outpaint) issues.push('Switch to Edit or clear the editing inputs.');
  } else {
    if (!capabilities.instructionEditing) issues.push('Editing is unavailable.');
    if (capabilities.sourceImageRequired && !draft.source) issues.push('Add a source image.');
    if (capabilities.maskRequired && !draft.mask && !draft.outpaint) issues.push('Paint a mask or expand the canvas.');
    if (draft.mask && capabilities.maskMode === 'none') issues.push('Masks are unavailable.');
    if (draft.outpaint && !capabilities.outpainting) issues.push('Canvas expansion is unavailable.');
    for (const group of draft.references) {
      if (!capabilities.referenceRoles.includes(group.role)) issues.push(`Reference ${group.id}: role ${group.role} is unavailable.`);
      const method = group.conditioning ?? 'prompt';
      const required = { prompt: 'ordered-images-with-role-prompt', identity: 'pooled-identity', appearance: 'appearance-embedding' }[method];
      if (capabilities.referenceConditioning !== required) issues.push(`Reference ${group.id}: ${method} conditioning is unavailable.`);
      if (!group.images.length) issues.push(`Reference ${group.id}: add a photo.`);
      if (method === 'identity' && !group.className) issues.push(`Reference ${group.id}: select an identity class.`);
    }
  }
  for (const key of Object.keys(draft.parameters)) {
    if (!Object.hasOwn(capabilities.parameters ?? {}, key)) issues.push(`Parameter ${key} is unavailable.`);
  }
  if (draft.control && !capabilities.controlKinds?.includes(draft.control.kind)) issues.push('A prepared Canny control model is required.');
  return issues;
}
