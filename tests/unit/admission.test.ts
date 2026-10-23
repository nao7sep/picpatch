import { expect, it } from 'vitest';
import { listModels } from 'picpatchsdk';
import { incompatibilities } from '../../src/shared/admission.ts';
import { t } from '../../src/shared/i18n/index.ts';
import { initialDraft } from '../../src/shared/session.ts';
it('preserves authored controls while explaining incompatible model choices', () => {
  const draft = { ...initialDraft(), mode: 'edit' as const, text: 'A portrait of {person}', references: [{ id: 'person', role: 'subject' as const, images: ['photo'], conditioning: 'identity' as const, className: 'man' as const }] };
  const before = structuredClone(draft);
  const klein = listModels().find(model => model.id === 'flux2-klein-4b-4bit')!;
  expect(incompatibilities(draft, klein.capabilities)).toContain('Reference person: Identity conditioning is unavailable.');
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
  expect(issues).toContain('Parameter Identity/style mixing strength is unavailable.');
});
it('allows independently bound subject groups without PhotoMaker class words', () => {
  const model = listModels().find(model => model.variant === 'flux1-dreamo-v1.1')!;
  const draft = { ...initialDraft(), mode: 'edit' as const, text: 'A portrait of {person}', references: [{ id: 'person', role: 'subject' as const, images: ['photo'], conditioning: 'identity' as const }] };
  expect(incompatibilities(draft, model.capabilities)).toEqual([]);
});

it('checks the original command for dedicated identity placeholders before submission', () => {
  const model = listModels().find(model => model.capabilities.referenceConditioning === 'pooled-identity')!;
  const draft = { ...initialDraft(), mode: 'edit' as const, references: [{ id: 'person', role: 'subject' as const, images: ['photo'], conditioning: 'identity' as const, className: 'man' as const }] };
  for (const text of ['Portrait', '{person} beside {person}', '{person} img']) expect(incompatibilities({ ...draft, text }, model.capabilities), text).toContain(t('admission.independent', { reference: 'person' }));
  const text = '  Portrait of {person}\nwith a blue coat  ';
  expect(incompatibilities({ ...draft, text }, model.capabilities)).toEqual([]);
  expect(text).toBe('  Portrait of {person}\nwith a blue coat  ');
});
it('requires each independently bound subject placeholder and rejects caller-supplied learned indices', () => {
  const model = listModels().find(model => model.variant === 'flux1-dreamo-v1.1')!;
  const draft = { ...initialDraft(), mode: 'edit' as const, references: ['first', 'second'].map(id => ({ id, role: 'subject' as const, images: [id], conditioning: 'identity' as const })) };
  expect(incompatibilities({ ...draft, text: '{first} alone' }, model.capabilities)).not.toEqual([]);
  expect(incompatibilities({ ...draft, text: '{first} and {second} [ref#1]' }, model.capabilities)).not.toEqual([]);
  expect(incompatibilities({ ...draft, text: '{first} and {second}' }, model.capabilities)).toEqual([]);
});

it('admits the effective expansion or source-sized mask rather than unrelated ordinary dimensions', () => {
  const model = listModels().find(model => model.capabilities.maskMode === 'composite' && model.capabilities.outpainting)!;
  const caps = { ...model.capabilities, size: { widthMultiple: 16, heightMultiple: 16 } };
  const draft = { ...initialDraft(), mode: 'edit' as const, source: 'source', text: 'Blue', width: 1001, height: 1003 };
  expect(incompatibilities(draft, caps)).toContain(t('admission.size'));
  expect(incompatibilities({ ...draft, outpaint: { width: 1280, height: 1280, left: 128, top: 128 } }, caps)).toEqual([]);
  expect(incompatibilities({ ...draft, mask: 'mask' }, caps)).toEqual([]);
  expect(incompatibilities({ ...draft, mask: 'mask' }, { ...caps, maskMode: 'native' })).toContain(t('admission.size'));
});
