// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { SettingsModal, type SettingsGuard } from '../../src/renderer/src/modals/SettingsModal.tsx';
import type { Overview } from '../../src/renderer/src/api.ts';
import { fakeBridge } from '../helpers/bridge.ts';

afterEach(cleanup);
function start(profile: Overview['settings']['profile'] = {}) {
  const fake = fakeBridge(); window.picpatch = fake.bridge;
  const overview = fake.handlers.overview!(undefined) as Overview;
  overview.settings.profile = profile;
  overview.locations = { ...overview.locations, ...profile };
  fake.handlers.preferences = () => overview;
  render(<SettingsModal overview={overview} guard={createRef<SettingsGuard>()} onClose={vi.fn()} onSaved={vi.fn()} confirmDiscard={async () => true} />);
  fireEvent.click(screen.getByRole('tab', { name: 'Resources' }));
  return fake;
}
const choose = (index: number) => fireEvent.click(screen.getAllByRole('button', { name: /^(Engine folder|Models folder|External native executable)/ })[index]!);

it('seeds empty resources from effective defaults, uses authored drafts first and keeps drafts on cancellation', async () => {
  const fake = start({ modelsDirectory: '/saved/models', nativeExecutable: '/saved/sd-cli' });
  choose(0); await waitFor(() => expect(fake.calls('pickPath')).toHaveLength(1));
  expect(fake.calls('pickPath')[0]).toEqual({ file: false, initialPath: '/e' });
  const models = screen.getByRole('textbox', { name: /Models folder/ }) as HTMLInputElement;
  fireEvent.change(models, { target: { value: ' /draft/models ' } });
  choose(1); await waitFor(() => expect(fake.calls('pickPath')).toHaveLength(2));
  expect(fake.calls('pickPath')[1]).toEqual({ file: false, initialPath: '/draft/models' });
  expect(models.value).toBe(' /draft/models ');
  choose(2); await waitFor(() => expect(fake.calls('pickPath')).toHaveLength(3));
  expect(fake.calls('pickPath')[2]).toEqual({ file: true, initialPath: '/saved/sd-cli' });
  fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
  await waitFor(() => expect(fake.calls('preferences')[0]).toMatchObject({ modelsDirectory: '/draft/models' }));
});

it('uses the engine location for an unset executable and preserves native and saved path spelling on save', async () => {
  const saved = '/saved/$HOME/models ';
  const fake = start({ modelsDirectory: saved });
  choose(2); await waitFor(() => expect(fake.calls('pickPath')[0]).toEqual({ file: true, initialPath: '/e' }));
  const selected = '/native/$HOME/engine ';
  fake.handlers.pickPath = () => selected;
  choose(0); await waitFor(() => expect((screen.getByRole('textbox', { name: /Engine folder/ }) as HTMLInputElement).value).toBe(selected));
  choose(0); await waitFor(() => expect(fake.calls('pickPath')).toHaveLength(3));
  expect(fake.calls('pickPath')[2]).toEqual({ file: false, initialPath: selected });
  fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
  await waitFor(() => expect(fake.calls('preferences')[0]).toEqual({ engineDirectory: selected, modelsDirectory: saved }));
});

it('uses SDK defaults after clearing saved resource overrides', async () => {
  const fake = start({ engineDirectory: '/saved/engine', modelsDirectory: '/saved/models' });
  fireEvent.change(screen.getByRole('textbox', { name: /Engine folder/ }), { target: { value: '' } });
  fireEvent.change(screen.getByRole('textbox', { name: /Models folder/ }), { target: { value: '' } });
  choose(0); choose(1);
  await waitFor(() => expect(fake.calls('pickPath')).toEqual([{ file: false, initialPath: '/e' }, { file: false, initialPath: '/m' }]));
});
