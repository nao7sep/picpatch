// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { listModels } from 'picpatchsdk';
import { admissionIssues } from 'picpatchsdk/types';
import { OptionsPane } from '../../src/renderer/src/components/OptionsPane.tsx';
import { fieldProblem, NumberFields, type FieldEdit } from '../../src/renderer/src/number-field.tsx';
import type { Draft } from '../../src/shared/session.ts';
import { initialDraft } from '../../src/shared/session.ts';
import { session } from '../helpers/bridge.ts';
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('preserves explicit empty negative prompt separately from reset across guidance changes', () => {
  const model = listModels().find(model => model.id === 'qwen-image-2.1')!;
  let draft = { ...initialDraft(), modelIds: [model.id], parameters: { guidance: 2, negativePrompt: 'blur' } };
  const draw = () => <OptionsPane session={session()} draft={draft} models={[model]} samples={1} onSamples={() => {}} onDraft={next => { draft = next as typeof draft; view.rerender(draw()); }} onPaintMask={() => {}} onChooseControl={() => {}} onClose={() => {}} />;
  const view = render(draw());
  fireEvent.change(screen.getByRole('textbox', { name: 'Negative prompt' }), { target: { value: '' } });
  expect(draft.parameters.negativePrompt).toBe('');
  expect(admissionIssues({ operation: 'generate', parameters: draft.parameters }, model.capabilities)).toEqual([]);
  fireEvent.change(screen.getByRole('textbox', { name: 'Guidance' }), { target: { value: '1' } });
  expect(admissionIssues({ operation: 'generate', parameters: draft.parameters }, model.capabilities)).toContainEqual(expect.objectContaining({ subject: 'negativePrompt' }));
  fireEvent.click(screen.getByRole('button', { name: 'Default' }));
  expect(draft.parameters).not.toHaveProperty('negativePrompt');
  expect(admissionIssues({ operation: 'generate', parameters: draft.parameters }, model.capabilities)).toEqual([]);
  fireEvent.change(screen.getByRole('textbox', { name: 'Guidance' }), { target: { value: '2' } });
  expect(admissionIssues({ operation: 'generate', parameters: draft.parameters }, model.capabilities)).toContainEqual(expect.objectContaining({ subject: 'guidance' }));
  fireEvent.focus(screen.getByRole('textbox', { name: 'Negative prompt' }));
  expect(draft.parameters.negativePrompt).toBe('');
  expect(admissionIssues({ operation: 'generate', parameters: draft.parameters }, model.capabilities)).toEqual([]);
  fireEvent.change(screen.getByRole('textbox', { name: 'Negative prompt' }), { target: { value: 'unwanted' } });
  expect(draft.parameters.negativePrompt).toBe('unwanted');
});

it('checks the canvas fields again together, committing a refused offset once the canvas holds it', async () => {
  // The image being edited is 512 × 512.
  vi.stubGlobal('Image', class { naturalWidth = 512; naturalHeight = 512; onload: (() => void) | null = null; set src(_url: string) { queueMicrotask(() => this.onload?.()); } });
  const model = listModels().find(model => model.capabilities.outpainting)!;
  let draft: Draft = { ...initialDraft(), modelIds: [model.id], source: 'asset-1', outpaint: { width: 768, height: 768, left: 128, top: 128 } };
  let edits: Record<string, FieldEdit> = {};
  function Pane() {
    const [current, setCurrent] = useState(draft);
    const [fields, setFields] = useState<Record<string, FieldEdit>>({});
    draft = current; edits = fields;
    const edit = (id: string, value: FieldEdit | undefined) => setFields(previous => { const next = { ...previous }; if (value) next[id] = value; else delete next[id]; return next; });
    return <NumberFields value={{ edits: fields, edit }}><OptionsPane session={session()} draft={current} models={[model]} samples={1} onSamples={() => {}} onDraft={setCurrent} onPaintMask={() => {}} onChooseControl={() => {}} onClose={() => {}} /></NumberFields>;
  }
  render(<Pane />);
  await act(async () => {});
  const field = (name: string) => screen.getByRole('textbox', { name });

  fireEvent.change(field('Source horizontal offset'), { target: { value: '300' } });
  expect(fieldProblem(edits)).toBe('Source horizontal offset: Enter a whole number from 0 to 256.');
  expect(draft.outpaint!.left).toBe(128);
  // A wider canvas leaves room for the typed offset, which commits with it and no longer holds Run back.
  fireEvent.change(field('Width'), { target: { value: '900' } });
  expect(draft.outpaint).toEqual({ width: 900, height: 768, left: 300, top: 128 });
  expect(fieldProblem(edits)).toBeUndefined();
  expect((field('Source horizontal offset') as HTMLInputElement).value).toBe('300');

  // An offset still too far keeps its reason, which follows the new bounds.
  fireEvent.change(field('Source vertical offset'), { target: { value: '600' } });
  expect(fieldProblem(edits)).toBe('Source vertical offset: Enter a whole number from 0 to 256.');
  fireEvent.change(field('Height'), { target: { value: '1000' } });
  expect(fieldProblem(edits)).toBe('Source vertical offset: Enter a whole number from 0 to 488.');
  expect(draft.outpaint).toEqual({ width: 900, height: 1000, left: 300, top: 128 });
  fireEvent.change(field('Height'), { target: { value: '1200' } });
  expect(draft.outpaint).toEqual({ width: 900, height: 1200, left: 300, top: 600 });
  expect(fieldProblem(edits)).toBeUndefined();
});
