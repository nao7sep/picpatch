import { expect, it } from 'vitest';
import { listModels } from 'picpatchsdk';
import { incompatibilities } from '../../src/shared/admission.ts';
import { initialDraft } from '../../src/app/types.ts';
it('preserves authored controls while explaining incompatible model choices', () => {
  const draft = { ...initialDraft(), mode: 'edit' as const, references: [{ id: 'person', role: 'subject' as const, images: ['photo'], conditioning: 'identity' as const, className: 'man' as const }] };
  const before = structuredClone(draft);
  const klein = listModels().find(model => model.id === 'flux2-klein-4b-4bit')!;
  expect(incompatibilities(draft, klein.capabilities)).toContain('Reference person: identity conditioning is unavailable.');
  const identity = listModels().find(model => model.capabilities.referenceConditioning === 'pooled-identity')!;
  expect(incompatibilities(draft, identity.capabilities)).toEqual([]);
  expect(draft).toEqual(before);
});
it('does not mistake an unsupported parameter or mask for an ignored hint', () => {
  const model = listModels().find(model => model.variant === 'sdxl')!;
  const draft = { ...initialDraft(), mode: 'edit' as const, mask: 'mask', parameters: { identityStyleStrength: 0.5 } };
  const issues = incompatibilities(draft, model.capabilities);
  expect(issues).toContain('Masks are unavailable.');
  expect(issues).toContain('Add a source image.');
  expect(issues).toContain('Parameter identityStyleStrength is unavailable.');
});
