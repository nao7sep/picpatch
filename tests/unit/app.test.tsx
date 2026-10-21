// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { App } from '../../src/renderer/src/App.tsx';
import { DRAFT_DELAY } from '../../src/renderer/src/draft-writer.ts';
import { fakeBridge, run, session } from '../helpers/bridge.ts';
import { leakedMessages } from '../helpers/rendered-messages.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
beforeEach(() => { Element.prototype.scrollIntoView ??= () => {}; });
afterEach(() => { cleanup(); vi.useRealTimers(); });

async function start(fake = fakeBridge()) {
  window.picpatch = fake.bridge;
  render(<App />);
  await screen.findByRole('textbox', { name: 'Command' });
  return fake;
}
const field = () => screen.getByRole('textbox', { name: 'Command' }) as HTMLTextAreaElement;
const send = () => screen.getByRole('button', { name: 'Run command' });

it('opens the newest session, reports ready after the workspace shows, and leaks no message keys', async () => {
  const fake = await start(fakeBridge(session({ runs: [run('a1')] })));
  await waitFor(() => expect(fake.calls('ready')).toHaveLength(1));
  expect(screen.getByRole('listbox', { name: 'Sessions' })).toBeTruthy();
  expect(screen.getByText('Command a1')).toBeTruthy();
  expect(leakedMessages(document.body)).toEqual([]);
});

it('keeps the workspace behind a recovery surface when a required read fails, and retries without creating a session', async () => {
  let fail = true;
  const fake = fakeBridge(session(), { get: () => { if (fail) throw Object.assign(new Error('disk said no'), { code: 'IO_ERROR' }); return session(); } });
  window.picpatch = fake.bridge;
  render(<App />);
  expect(await screen.findByRole('heading', { name: 'PicPatch could not open' })).toBeTruthy();
  expect(document.body.textContent).not.toContain('disk said no');
  expect(fake.calls('ready')).toHaveLength(0);
  fail = false;
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await screen.findByRole('textbox', { name: 'Command' });
  expect(fake.calls('create')).toHaveLength(0);
});

it('saves typing after a pause, runs on Enter but never during composition, and targets the new result', async () => {
  const fake = await start(fakeBridge(session(), { submit: ({ draft }: any) => [run('r1', { status: 'queued', output: undefined, draft })] }));
  fireEvent.change(field(), { target: { value: 'A red barn' } });
  await waitFor(() => expect(fake.calls('draft').at(-1)).toMatchObject({ draft: { text: 'A red barn' } }), { timeout: DRAFT_DELAY * 4 });
  fireEvent.keyDown(field(), { key: 'Enter', isComposing: true });
  expect(fake.calls('submit')).toHaveLength(0);
  fireEvent.keyDown(field(), { key: 'Enter' });
  await waitFor(() => expect(fake.calls('submit')).toHaveLength(1));
  expect(fake.calls('submit')[0]).toMatchObject({ draft: { text: 'A red barn', mode: 'generate' }, samples: 1 });
  await waitFor(() => expect(field().value).toBe(''));
  expect(screen.getByText('Editing')).toBeTruthy();
  // The pending result cannot be edited until it exists.
  fireEvent.change(field(), { target: { value: 'Add snow' } });
  expect((send() as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText('The target image is not ready. Wait, select another image, or choose New image.')).toBeTruthy();
});

it('keeps a refused command and its inputs in the composer', async () => {
  const fake = await start(fakeBridge(session({ runs: [run('a1')] }), { submit: () => { throw Object.assign(new Error('x'), { notice: { key: 'error.input' } }); } }));
  fireEvent.click(screen.getByRole('button', { name: 'Edit this result' }));
  fireEvent.change(field(), { target: { value: 'Make it night' } });
  fireEvent.click(send());
  await screen.findByRole('alert');
  expect(field().value).toBe('Make it night');
  expect(fake.session.draft.source).toBe('a1');
});

it('explains an unready model and offers setup instead of running', async () => {
  const fake = await start(fakeBridge(session({ draft: { ...session().draft, modelIds: ['sd15'], text: 'x' } })));
  expect(screen.getByText('Stable Diffusion 1.5 is not set up yet.')).toBeTruthy();
  expect((send() as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Set up' }));
  expect(await screen.findByRole('dialog', { name: 'Set up PicPatch' })).toBeTruthy();
  expect(fake.calls('prepare')).toHaveLength(0);
  expect(fake.calls('installPython')).toHaveLength(0);
});

it('edits a result, reuses its settings and groups runs submitted together', async () => {
  const twin = { ...session().draft, text: 'Twins', modelIds: ['flux2-klein-4b-4bit'] };
  await start(fakeBridge(session({ runs: [run('a1', { seed: 41, draft: { ...twin, text: 'Wide', width: 832 } }), run('b1', { created: 'same', draft: twin }), run('b2', { created: 'same', draft: twin, seed: 8 })] })));
  expect(screen.getAllByText('Twins')).toHaveLength(1);
  fireEvent.click(screen.getAllByRole('button', { name: 'Reuse settings' })[0]!);
  await waitFor(() => expect(field().value).toBe('Wide'));
  expect(screen.getByText('2 results')).toBeTruthy();
  const options = screen.getAllByRole('button', { name: 'Image options' })[0]!;
  fireEvent.click(options);
  expect((screen.getByRole('spinbutton', { name: 'Seed' }) as HTMLInputElement).value).toBe('41');
});

it('drops one image to edit it when nothing is being edited, and later images as a reference group', async () => {
  let next = 0;
  const fake = await start(fakeBridge(session(), { import: () => [{ id: `00000000-0000-4000-8000-00000000000${next++}`, name: `photo${next}.png`, file: 'x', bytes: 1, sha256: 'x' }] }));
  const zone = document.querySelector('[data-drop-receiver]')!;
  const drop = (count: number) => fireEvent.drop(zone, { dataTransfer: { types: ['Files'], files: Array.from({ length: count }, (_, i) => new File(['x'], `f${i}.png`)) } });
  drop(1);
  await waitFor(() => expect(fake.session.draft.source).toBe('00000000-0000-4000-8000-000000000000'));
  drop(2);
  await waitFor(() => expect(fake.session.draft.references).toHaveLength(1));
  expect(fake.session.draft.references[0]!.images).toHaveLength(2);
  expect(fake.calls('import').map((payload: any) => payload.path)).toEqual(['/drops/f0.png', '/drops/f0.png', '/drops/f1.png']);
});

it('blocks workspace shortcuts and commands behind a modal and closes only the front surface', async () => {
  const fake = await start();
  await act(async () => fake.command('settingsButton'));
  expect(screen.getByRole('dialog', { name: 'Settings' })).toBeTruthy();
  await act(async () => fake.command('new'));
  expect(fake.calls('create')).toHaveLength(0);
  await act(async () => fake.command('closeWindow'));
  expect(screen.queryByRole('dialog', { name: 'Settings' })).toBeNull();
  expect(fake.calls('closeWindow')).toHaveLength(0);
  await act(async () => fake.command('closeWindow'));
  expect(fake.calls('closeWindow')).toHaveLength(1);
});

it('asks before discarding changed settings and saves only chosen values', async () => {
  const fake = await start(fakeBridge(session(), { preferences: () => fake.handlers.overview!(undefined) }));
  await act(async () => fake.command('settingsButton'));
  fireEvent.change(screen.getByRole('textbox', { name: 'Interface font family' }), { target: { value: 'Avenir' } });
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  const question = await screen.findByRole('dialog', { name: 'Discard changes?' });
  expect(within(question).getByText('You have unsaved changes. Discard them and close?')).toBeTruthy();
  expect(within(question).getByRole('button', { name: 'Discard' })).toBeTruthy();
  fireEvent.click(within(question).getByRole('button', { name: 'Keep editing' }));
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Discard changes?' })).toBeNull());
  fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
  await waitFor(() => expect(fake.calls('preferences')).toEqual([{ uiFont: 'Avenir' }]));
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Settings' })).toBeNull());
});

it('answers main questions in order, treats dismissal as no, and settles pending saves on flush', async () => {
  const fake = await start();
  let answer: Promise<unknown>;
  await act(async () => { answer = fake.request({ kind: 'message', message: { title: { key: 'ui.delete_this_session_and_its_retained_images' }, actions: [{ label: { key: 'ui.keep_session' } }, { label: { key: 'ui.delete_session' }, destructive: true }] } }); });
  const dialog = await screen.findByRole('dialog', { name: 'Delete this session and its retained images?' });
  expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Keep session' }));
  fireEvent.keyDown(dialog, { key: 'Escape' });
  await expect(answer!).resolves.toBeUndefined();
  fireEvent.change(field(), { target: { value: 'Unsaved words' } });
  await act(async () => { await fake.request({ kind: 'flush' }); });
  expect(fake.session.draft.text).toBe('Unsaved words');
  await expect(fake.request({ kind: 'closeDrafts' })).resolves.toBe(true);
});

it('asks about prompt disclosure for each settings file and exports nothing on dismissal', async () => {
  const fake = await start(fakeBridge(session({ runs: [run('a1')] }), { export: () => ({ status: 'completed' }) }));
  fireEvent.click(screen.getByRole('button', { name: 'Save image' }));
  let dialog = await screen.findByRole('dialog', { name: 'Save image' });
  const prompts = within(dialog).getByRole('checkbox', { name: 'Include prompts' }) as HTMLInputElement;
  expect(prompts.disabled).toBe(true);
  fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Also save a settings file' }));
  fireEvent.click(prompts);
  fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  expect(fake.calls('export')).toHaveLength(0);
  fireEvent.click(screen.getByRole('button', { name: 'Save image' }));
  dialog = await screen.findByRole('dialog', { name: 'Save image' });
  expect((within(dialog).getByRole('checkbox', { name: 'Include prompts' }) as HTMLInputElement).checked).toBe(false);
  fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Also save a settings file' }));
  fireEvent.click(within(dialog).getByRole('button', { name: 'Choose location' }));
  await waitFor(() => expect(fake.calls('export')).toEqual([{ id: fake.session.id, runId: 'a1', sidecar: true, includeInputs: false }]));
  expect(await screen.findByText('Image saved.')).toBeTruthy();
});

it('ignores native commands while an input method is composing', async () => {
  const fake = await start();
  fireEvent.compositionStart(field());
  await act(async () => fake.command('settingsButton'));
  expect(screen.queryByRole('dialog', { name: 'Settings' })).toBeNull();
  fireEvent.compositionEnd(field());
  await new Promise(resolve => requestAnimationFrame(resolve));
  await act(async () => fake.command('settingsButton'));
  expect(screen.getByRole('dialog', { name: 'Settings' })).toBeTruthy();
});

it('dismisses open questions and the export choice when closing begins, then restores the workspace', async () => {
  const fake = await start(fakeBridge(session({ runs: [run('a1')] })));
  fireEvent.click(screen.getByRole('button', { name: 'Save image' }));
  await screen.findByRole('dialog', { name: 'Save image' });
  await act(async () => fake.command('beginClose'));
  expect(screen.queryByRole('dialog', { name: 'Save image' })).toBeNull();
  expect(document.querySelector('.shell')!.hasAttribute('inert')).toBe(true);
  await act(async () => fake.command('endClose'));
  expect(document.querySelector('.shell')!.hasAttribute('inert')).toBe(false);
});

it('describes each model and groups ready models before the ones to set up', async () => {
  await start(fakeBridge(session()));
  fireEvent.click(screen.getByRole('button', { name: /FLUX\.2 Klein 4B/ }));
  const list = await screen.findByRole('radiogroup', { name: 'Models' });
  expect(within(list).getByText('Ready to use')).toBeTruthy();
  expect(within(list).getByText('Quick drafts · Editing')).toBeTruthy();
  expect(within(list).getByText('Under 8 GB memory · Fast · Tested')).toBeTruthy();
  expect(within(list).getByText('Download')).toBeTruthy(); expect(within(list).queryByText('Stable Diffusion 1.5')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Show more models' }));
  expect(within(list).getByText('More models')).toBeTruthy(); expect(within(list).getByText('Your files')).toBeTruthy();
});

it('says when models this computer cannot run are hidden, and reports a session model it cannot run as unavailable', async () => {
  const base = fakeBridge(session({ draft: { ...session().draft, modelIds: ['mac-only'], text: 'x' } }));
  const overview = await base.bridge.call('overview');
  await start(fakeBridge(session({ draft: { ...session().draft, modelIds: ['mac-only'], text: 'x' } }), { overview: () => ({ ...overview, unsupportedModels: 3 }) }));
  expect(screen.getByText('Mac Only: model unavailable.')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: /Mac Only/ }));
  expect(await screen.findByText('More models run on Apple Silicon Macs.')).toBeTruthy();
});

it('moves the sessions rail with arrow keys and saves its width once, on key release', async () => {
  const fake = await start();
  const splitter = screen.getByRole('separator', { name: 'Session list width' });
  const before = Number(splitter.getAttribute('aria-valuenow'));
  for (let i = 0; i < 3; i++) fireEvent.keyDown(splitter, { key: 'ArrowRight' });
  expect(Number(splitter.getAttribute('aria-valuenow'))).toBe(before + 24);
  expect(fake.calls('savePane')).toEqual([]);
  fireEvent.keyUp(splitter, { key: 'ArrowRight' });
  await waitFor(() => expect(fake.calls('savePane')).toEqual([{ railWidth: before + 24, optionsPane: false }]));
  fireEvent.blur(splitter);
  expect(fake.calls('savePane')).toHaveLength(1);
});

it('asks the fleet discard question when quitting with unsaved settings, keeping them by default', async () => {
  const fake = await start();
  await act(async () => fake.command('settingsButton'));
  fireEvent.change(screen.getByRole('textbox', { name: 'Interface font family' }), { target: { value: 'Avenir' } });
  let answer: Promise<unknown>;
  await act(async () => { answer = fake.request({ kind: 'closeDrafts' }); });
  const question = await screen.findByRole('dialog', { name: 'Discard changes?' });
  expect(within(question).getByText('You have unsaved changes. Discard them and quit?')).toBeTruthy();
  expect(document.activeElement).toBe(within(question).getByRole('button', { name: 'Keep editing' }));
  fireEvent.click(within(question).getByRole('button', { name: 'Keep editing' }));
  await expect(answer!).resolves.toBe(false);
  expect(screen.getByRole('dialog', { name: 'Settings' })).toBeTruthy();
});

it('keeps export choices after a filename conflict and retries only on an explicit click', async () => {
  const fake = await start(fakeBridge(session({ runs: [run('a1')] }), { export: () => ({ status: 'refused', code: 'OUTPUT_CONFLICT' }) }));
  fireEvent.click(screen.getByRole('button', { name: 'Save image' }));
  const dialog = await screen.findByRole('dialog', { name: 'Save image' });
  const sidecar = within(dialog).getByRole('checkbox', { name: 'Also save a settings file' }) as HTMLInputElement;
  const prompts = within(dialog).getByRole('checkbox', { name: 'Include prompts' }) as HTMLInputElement;
  const choose = within(dialog).getByRole('button', { name: 'Choose location' });
  fireEvent.click(sidecar); fireEvent.click(prompts); fireEvent.click(choose);
  expect(await within(dialog).findByRole('alert')).toHaveProperty('textContent', 'PicPatch saves new files only. Choose an unused filename.');
  expect(sidecar.checked).toBe(true); expect(prompts.checked).toBe(true);
  expect(fake.calls('export')).toHaveLength(1);
  fake.handlers.export = () => undefined;
  fireEvent.click(choose);
  await waitFor(() => expect((choose as HTMLButtonElement).disabled).toBe(false));
  expect(fake.calls('export')).toHaveLength(2);
  expect(sidecar.checked).toBe(true); expect(prompts.checked).toBe(true);
  fake.handlers.export = () => ({ status: 'completed' });
  fireEvent.click(choose);
  expect(await screen.findByText('Image saved.')).toBeTruthy();
  expect(fake.calls('export')).toEqual(Array(3).fill({ id: fake.session.id, runId: 'a1', sidecar: true, includeInputs: true }));
});
