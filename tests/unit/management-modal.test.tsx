// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ManagementModal } from '../../src/renderer/src/modals/ManagementModal.tsx';
import type { Overview } from '../../src/renderer/src/api.ts';
import { fakeBridge } from '../helpers/bridge.ts';

afterEach(cleanup);
it('keeps first bundle selection generic, reuses the chosen bundle for replacement and all component choices, and preserves cancel', async () => {
  const fake = fakeBridge(); window.picpatch = fake.bridge;
  fake.handlers.engines = () => ({ python: { status: 'ready' }, native: { status: 'ready' } });
  fake.handlers.models = () => ({ entries: [] });
  const overview = fake.handlers.overview!(undefined) as Overview;
  render(<ManagementModal models={overview.models.map(model => ({ ...model, capabilities: { ...model.capabilities, loraFormats: ['sd-unet-safetensors'] } }))} initial="sd15" readiness={{}} managed={{}} onClose={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: 'Register local bundle' }));
  const choose = (label: string) => fireEvent.click(within(screen.getByText(label).closest('.field') as HTMLElement).getByRole('button', { name: 'Choose' }));
  choose('Bundle directory');
  await waitFor(() => expect(fake.calls('pickPath')[0]).toEqual({ file: false, initialPath: undefined }));
  const directory = '/bundles/native ';
  fake.handlers.pickPath = () => directory;
  choose('Bundle directory');
  await screen.findByTitle(directory, { normalizer: value => value });
  fake.handlers.pickPath = () => undefined;
  choose('Bundle directory');
  await waitFor(() => expect(fake.calls('pickPath')[2]).toEqual({ file: false, initialPath: directory }));
  expect(screen.getByTitle(directory, { normalizer: value => value })).toBeTruthy();
  choose('VAE');
  await waitFor(() => expect(fake.calls('pickComponent')[0]).toEqual({ directory, current: undefined }));
  choose('Checkpoint');
  await waitFor(() => expect(fake.calls('pickComponent')[1]).toEqual({ directory, current: '' }));
  fireEvent.click(screen.getByRole('button', { name: 'Add LoRA' }));
  await waitFor(() => expect(fake.calls('pickComponent')[2]).toEqual({ directory, current: undefined }));
  expect(screen.getByTitle(directory, { normalizer: value => value })).toBeTruthy();
});

it('reopens each component and checkpoint at its current selection and keeps it after cancellation', async () => {
  const fake = fakeBridge(); window.picpatch = fake.bridge;
  fake.handlers.engines = () => ({ python: { status: 'ready' }, native: { status: 'ready' } });
  fake.handlers.models = () => ({ entries: [] });
  fake.handlers.pickPath = () => '/bundles/native';
  const overview = fake.handlers.overview!(undefined) as Overview;
  render(<ManagementModal models={overview.models} initial="sd15" readiness={{}} managed={{}} onClose={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: 'Register local bundle' }));
  const choose = (label: string) => fireEvent.click(within(screen.getByText(label).closest('.field') as HTMLElement).getByRole('button', { name: 'Choose' }));
  choose('Bundle directory');
  await screen.findByTitle('/bundles/native');
  for (const [label, current] of [['VAE', 'encoders/vae.safetensors'], ['Checkpoint', 'checkpoints/model.safetensors']]) {
    fake.handlers.pickComponent = () => current;
    choose(label!);
    await screen.findByTitle(current!);
    fake.handlers.pickComponent = () => undefined;
    choose(label!);
    await waitFor(() => expect(fake.calls('pickComponent').at(-1)).toEqual({ directory: '/bundles/native', current }));
    expect(screen.getByTitle(current!)).toBeTruthy();
  }
});

const running = { active: { id: 3, action: 'download' as const, modelId: 'flux2-klein-4b-4bit', progress: { completed: 42, total: 100 } } };
function managementWithWork(managed: Parameters<typeof ManagementModal>[0]['managed'] = running) {
  const fake = fakeBridge(); window.picpatch = fake.bridge;
  fake.handlers.engines = () => ({ python: { status: 'ready' }, native: { status: 'ready' } });
  fake.handlers.models = () => ({ entries: [{ modelId: 'flux2-klein-4b-4bit', name: 'aaaaaaaaaaaaaaaa', bytes: 4.6e9 }, { modelId: 'flux2-klein-4b-4bit', name: 'bbbbbbbbbbbbbbbb', bytes: 4.6e9 }] });
  const overview = fake.handlers.overview!(undefined) as Overview;
  const onClose = vi.fn();
  const view = render(<ManagementModal models={overview.models} initial="flux2-klein-4b-4bit" readiness={{}} managed={managed} onClose={onClose} />);
  return { fake, onClose, view, overview };
}

it.each([
  ['the Close button', () => fireEvent.click(within(screen.getByRole('dialog')).getAllByRole('button', { name: 'Close' }).at(-1)!)],
  ['the header X', () => fireEvent.click(document.querySelector('.modal-close')!)],
  ['Escape', () => fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })],
  ['the backdrop', () => fireEvent.mouseDown(document.querySelector('.scrim')!)],
])('closes Managed tools by %s while work runs, leaving the work running', async (_path, close) => {
  const { fake, onClose } = managementWithWork();
  await screen.findByText(/^Downloading .+… 42%$/);
  const closeButton = within(screen.getByRole('dialog')).getAllByRole('button', { name: 'Close' }).at(-1) as HTMLButtonElement;
  expect(closeButton.disabled).toBe(false); expect((document.querySelector('.modal-close') as HTMLButtonElement).disabled).toBe(false);
  close();
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(fake.calls('cancelManaged')).toHaveLength(0);
});

it('offers Cancel on the running row only, and cancelling it touches no other row or work', async () => {
  const removal = { active: { id: 4, action: 'remove' as const, modelId: 'flux2-klein-4b-4bit', revision: 'aaaaaaaaaaaaaaaa' } };
  const { fake } = managementWithWork(removal);
  const rows = await waitFor(() => { const items = [...document.querySelectorAll('.revision-list li')] as HTMLElement[]; expect(items).toHaveLength(2); return items; });
  expect(within(rows[0]!).getByRole('button', { name: 'Cancel' })).toBeTruthy();
  expect(within(rows[0]!).queryByRole('button', { name: 'Remove revision' })).toBeNull();
  // The other revision keeps its own action, held back only while the one operation runs.
  expect((within(rows[1]!).getByRole('button', { name: 'Remove revision' }) as HTMLButtonElement).disabled).toBe(true);
  expect(within(rows[1]!).queryByRole('button', { name: 'Cancel' })).toBeNull();
  // The model's own actions stay as they are: the running work is a revision row's, not theirs.
  expect(screen.getByRole('button', { name: 'Download' })).toBeTruthy();
  fireEvent.click(within(rows[0]!).getByRole('button', { name: 'Cancel' }));
  await waitFor(() => expect(fake.calls('cancelManaged')).toHaveLength(1));
  expect(fake.call.mock.calls.map(([action]) => action).filter(action => ['removeManaged', 'prepare', 'verify', 'installPython', 'installNative'].includes(action))).toEqual([]);
});

it('starts work without waiting for it and shows the result application state reports', async () => {
  const { fake, view, overview } = managementWithWork({});
  fake.handlers.prepare = () => ({ started: true });
  fireEvent.click(await screen.findByRole('button', { name: 'Download' }));
  await waitFor(() => expect(fake.calls('prepare')).toEqual([{ modelId: 'flux2-klein-4b-4bit', download: true }]));
  view.rerender(<ManagementModal models={overview.models} initial="flux2-klein-4b-4bit" readiness={{}} managed={{ last: { id: 5, action: 'download', modelId: 'flux2-klein-4b-4bit', status: 'failed', notice: { key: 'error.storage' } } }} onClose={vi.fn()} />);
  expect(await screen.findByRole('alert')).toBeTruthy();
});

it('shows the selected readiness failure and preserves another model’s ready state', async () => {
  const fake = fakeBridge(); window.picpatch = fake.bridge;
  fake.handlers.engines = () => ({ python: { status: 'ready' }, native: { status: 'ready' } });
  fake.handlers.models = () => ({ entries: [] });
  const overview = fake.handlers.overview!(undefined) as Overview;
  render(<ManagementModal models={overview.models} initial="flux2-klein-4b-4bit"
    readiness={{ 'flux2-klein-4b-4bit': { status: 'failed', notice: { key: 'error.storage' } }, sd15: 'ready' }} managed={{}} onClose={vi.fn()} />);
  expect((await screen.findByRole('alert')).textContent).toMatch(/files could not be read or saved/i);
  expect((screen.getByRole('button', { name: 'Verify selected model' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'sd15' } });
  expect(screen.queryByRole('alert')).toBeNull();
  expect((screen.getByRole('button', { name: 'Verify selected model' }) as HTMLButtonElement).disabled).toBe(false);
});
