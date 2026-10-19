import { expect, it } from 'vitest';
import { afterCommand, imageCommand, targetImage, recoverCommand } from '../../src/shared/image-command.ts';
import type { Run } from '../../src/shared/session.ts';
import { initialDraft } from '../../src/shared/session.ts';
it('selects operations from explicit inputs without interpreting command text', () => {
  const draft = { ...initialDraft(), text: 'Edit the image from yesterday' };
  expect(imageCommand(draft).mode).toBe('generate');
  expect(imageCommand({ ...draft, references: [{ id: 'person', role: 'subject', images: ['photo'] }] }).mode).toBe('edit');
  expect(imageCommand(draft).text).toBe(draft.text);
});
it.each(['failed', 'refused', 'cancelled', 'interrupted'] as const)('recovers the original target and command after %s', status => {
  const original = { ...initialDraft(), text: 'Make it blue', source: 'original', mask: 'mask', references: [{ id: 'subject', role: 'subject' as const, images: ['photo'] }] };
  const run: Run = { id: 'pending', modelId: original.modelIds[0]!, seed: 42, draft: original, status, created: new Date().toISOString() };
  expect(recoverCommand(afterCommand(original, run.id), [run])).toEqual(original);
  expect(recoverCommand({ ...afterCommand(original, run.id), text: 'My newer command', references: [] }, [run])).toMatchObject({ source: 'original', text: 'My newer command', references: [] });
  expect(recoverCommand(targetImage(original, 'elsewhere'), [run]).source).toBe('elsewhere');
  const generation = { ...run, draft: { ...initialDraft(), text: 'A teapot' } };
  expect(recoverCommand(afterCommand(generation.draft, run.id), [generation])).toEqual(generation.draft);
});
it('retains instructions and settings while changing targets and clears only source-specific geometry', () => {
  const draft = { ...initialDraft(), text: 'Make it brighter', source: 'first', mask: 'mask', outpaint: { width: 1200, height: 1200, left: 10, top: 10 }, references: [{ id: 'person', role: 'subject' as const, images: ['photo'] }] };
  expect(targetImage(draft, 'first').mask).toBe('mask');
  const next = targetImage(draft, 'second'); expect(next.mask).toBeUndefined(); expect(next.outpaint).toBeUndefined(); expect(next.text).toBe(draft.text);
  expect(afterCommand(draft, 'result')).toMatchObject({ text: '', source: 'result', references: draft.references, mode: 'edit' });
  expect(draft.source).toBe('first'); expect(draft.mask).toBe('mask');
});
