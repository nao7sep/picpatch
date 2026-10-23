// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { listModels } from 'picpatchsdk';
import { admissionIssues } from 'picpatchsdk/types';
import { OptionsPane } from '../../src/renderer/src/components/OptionsPane.tsx';
import { initialDraft } from '../../src/shared/session.ts';
import { session } from '../helpers/bridge.ts';
afterEach(cleanup);

it('preserves explicit empty negative prompt separately from reset across guidance changes', () => {
  const model = listModels().find(model => model.id === 'qwen-image-2.1')!;
  let draft = { ...initialDraft(), modelIds: [model.id], parameters: { guidance: 2, negativePrompt: 'blur' } };
  const draw = () => <OptionsPane session={session()} draft={draft} models={[model]} samples={1} onSamples={() => {}} onDraft={next => { draft = next as typeof draft; view.rerender(draw()); }} onPaintMask={() => {}} onChooseControl={() => {}} onClose={() => {}} />;
  const view = render(draw());
  fireEvent.change(screen.getByRole('textbox', { name: 'Negative prompt' }), { target: { value: '' } });
  expect(draft.parameters.negativePrompt).toBe('');
  expect(admissionIssues({ operation: 'generate', parameters: draft.parameters }, model.capabilities)).toEqual([]);
  fireEvent.change(screen.getByRole('spinbutton', { name: 'Guidance' }), { target: { value: '1' } });
  expect(admissionIssues({ operation: 'generate', parameters: draft.parameters }, model.capabilities)).toContainEqual(expect.objectContaining({ subject: 'negativePrompt' }));
  fireEvent.click(screen.getByRole('button', { name: 'Default' }));
  expect(draft.parameters).not.toHaveProperty('negativePrompt');
  expect(admissionIssues({ operation: 'generate', parameters: draft.parameters }, model.capabilities)).toEqual([]);
  fireEvent.change(screen.getByRole('spinbutton', { name: 'Guidance' }), { target: { value: '2' } });
  expect(admissionIssues({ operation: 'generate', parameters: draft.parameters }, model.capabilities)).toContainEqual(expect.objectContaining({ subject: 'guidance' }));
  fireEvent.focus(screen.getByRole('textbox', { name: 'Negative prompt' }));
  expect(draft.parameters.negativePrompt).toBe('');
  expect(admissionIssues({ operation: 'generate', parameters: draft.parameters }, model.capabilities)).toEqual([]);
  fireEvent.change(screen.getByRole('textbox', { name: 'Negative prompt' }), { target: { value: 'unwanted' } });
  expect(draft.parameters.negativePrompt).toBe('unwanted');
});
