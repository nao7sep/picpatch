// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { App } from '../../src/renderer/src/App.tsx';
import { fakeBridge, run, session } from '../helpers/bridge.ts';
const mask = vi.hoisted(() => ({ props: undefined as { onAccepted: (task: Promise<void>) => void; onClose: () => void } | undefined }));
vi.mock('../../src/renderer/src/modals/MaskModal.tsx', () => ({ MaskModal: (props: NonNullable<typeof mask.props>) => { mask.props = props; return null; } }));
afterEach(() => { cleanup(); mask.props = undefined; });

async function start() {
  const fake = fakeBridge(session({ runs: [run('source')] }));
  window.picpatch = fake.bridge; render(<App />);
  await screen.findByRole('textbox', { name: 'Command' });
  fireEvent.click(screen.getByRole('button', { name: 'Edit this result' }));
  fireEvent.click(screen.getByRole('button', { name: 'Paint mask' }));
  expect(mask.props).toBeDefined();
  return fake;
}

it('joins accepted mask encoding before capturing the final draft, including a later flush observer', async () => {
  const fake = await start();
  const accepted = Promise.withResolvers<void>();
  mask.props!.onAccepted(accepted.promise);
  let firstFinished = false, retryFinished = false;
  const first = fake.request({ kind: 'flush' }).then(() => { firstFinished = true; });
  const retry = fake.request({ kind: 'flush' }).then(() => { retryFinished = true; });
  await Promise.resolve();
  expect(firstFinished).toBe(false); expect(retryFinished).toBe(false);
  fireEvent.change(screen.getByRole('textbox', { name: 'Command' }), { target: { value: 'Authored while encoding' } });
  await act(async () => { accepted.resolve(); await Promise.all([first, retry]); });
  expect(fake.session.draft.text).toBe('Authored while encoding');
  expect(fake.calls('mask')).toEqual([]);
});

it('retains accepted mask failure across Retry, clearing it only after success or explicit discard', async () => {
  const fake = await start();
  const error = new Error('mask encoding failed');
  const failed = Promise.withResolvers<void>(); mask.props!.onAccepted(failed.promise);
  failed.reject(error); await Promise.resolve();
  await expect(fake.request({ kind: 'flush' })).rejects.toBe(error);
  await expect(fake.request({ kind: 'flush' })).rejects.toBe(error);
  expect(fake.calls('mask')).toEqual([]);
  const successful = Promise.withResolvers<void>(); mask.props!.onAccepted(successful.promise);
  successful.resolve(); await Promise.resolve();
  await expect(fake.request({ kind: 'flush' })).resolves.toBeUndefined();
  const failedAgain = Promise.withResolvers<void>(); mask.props!.onAccepted(failedAgain.promise);
  failedAgain.reject(error); await Promise.resolve();
  await expect(fake.request({ kind: 'flush' })).rejects.toBe(error);
  act(() => mask.props!.onClose());
  await expect(fake.request({ kind: 'flush' })).resolves.toBeUndefined();
});
