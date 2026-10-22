// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { SetupModal } from '../../src/renderer/src/modals/SetupModal.tsx';
import type { Overview } from '../../src/renderer/src/api.ts';
import { fakeBridge } from '../helpers/bridge.ts';

afterEach(cleanup);
function setupWithWork() {
  const fake = fakeBridge(); window.picpatch = fake.bridge;
  fake.handlers.engines = () => ({ python: { status: 'missing' }, native: { status: 'missing' } });
  const overview = fake.handlers.overview!(undefined) as Overview;
  const onClose = vi.fn();
  render(<SetupModal models={overview.models} initial="flux2-klein-4b-4bit" readiness={{}} managed={{ active: { id: 1, action: 'installPython', modelId: 'flux2-klein-4b-4bit' } }} onClose={onClose} onUse={vi.fn()} onManage={vi.fn()} />);
  return { fake, onClose };
}

it.each([
  ['Skip setup', () => fireEvent.click(screen.getByRole('button', { name: 'Skip setup' }))],
  ['the header X', () => fireEvent.click(document.querySelector('.modal-close')!)],
  ['Escape', () => fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })],
  ['the backdrop', () => fireEvent.mouseDown(document.querySelector('.scrim')!)],
])('closes Setup by %s while a step runs, leaving the step running', async (_path, close) => {
  const { fake, onClose } = setupWithWork();
  const step = (await screen.findByText('Installing the Python engine…')).closest('li') as HTMLElement;
  expect(within(step).getByRole('button', { name: 'Cancel' })).toBeTruthy();
  close();
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(fake.calls('cancelManaged')).toHaveLength(0);
});
