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
  render(<ManagementModal models={overview.models.map(model => ({ ...model, capabilities: { ...model.capabilities, loraFormats: ['sd-unet-safetensors'] } }))} initial="sd15" onClose={vi.fn()} onChanged={async () => ({})} />);
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
  render(<ManagementModal models={overview.models} initial="sd15" onClose={vi.fn()} onChanged={async () => ({})} />);
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
