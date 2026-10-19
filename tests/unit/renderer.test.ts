import { leakedMessages } from './rendered-messages.ts';
// @vitest-environment happy-dom
import { readFile } from 'node:fs/promises';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
const models = [{ id: 'flux2-klein-4b-4bit', capabilities: { model: 'flux2-klein-4b-4bit', textToImage: true, instructionEditing: true, referenceRoles: ['subject'], referenceConditioning: 'ordered-images-with-role-prompt', maskMode: 'composite', parameters: {} } }];
import { initialDraft } from '../../src/app/types.ts';
import type { Session } from '../../src/app/types.ts';
let session: Session;
let call: ReturnType<typeof vi.fn<(action: string, payload?: any) => Promise<any>>>;
let flush: () => Promise<void>;
let request: (request: import('../../src/shared/messages.ts').RendererRequest) => Promise<unknown>;
let menuCommand: (id: string) => void;
beforeEach(async () => {
  vi.resetModules();
  document.write((await readFile(`${process.cwd()}/src/renderer/index.html`, 'utf8')).replace(/<link[^>]*>/g, '').replace(/<script[\s\S]*?<\/script>/g, ''));
  const canvas = { clearRect: vi.fn(), drawImage: vi.fn(), getImageData: vi.fn(), putImageData: vi.fn() };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(canvas as never);
  session = { version: 1, id: '11111111-1111-4111-8111-111111111111', name: 'Test', created: new Date().toISOString(), updated: new Date().toISOString(), assets: [], runs: [], draft: initialDraft() };
  call = vi.fn(async (action: string, payload?: any) => {
    if (action === 'paneState') return { requestWidth: 300, sidebar: false };
    if (action === 'overview') return { sessions: [session], failures: [], models, queue: { paused: false }, settings: { profile: { version: 1 }, registrations: {} }, locations: {} };
    if (action === 'get') return structuredClone(session);
    if (action === 'draft') { session.draft = structuredClone(payload.draft); return session; }
    if (action === 'import') return [{ id: '22222222-2222-4222-8222-222222222222', name: 'photo.png' }];
  });
  window.picpatch = { call, onChange: () => () => {}, onCommand: listener => { menuCommand = listener; return () => {}; }, onRequest: listener => { flush = async () => { await listener({ kind: 'flush' }); }; request = listener; }, droppedFile: () => '/fixture/photo.png' };
  await import('../../src/renderer/main.ts');
  await vi.waitFor(() => expect(call).toHaveBeenCalledWith('ready'));
});
afterEach(async () => { window.dispatchEvent(new Event('pagehide')); if (flush) await flush(); expect(leakedMessages(document.body)).toEqual([]); vi.restoreAllMocks(); document.body.replaceChildren(); });
const field = (id: string) => document.getElementById(id)! as HTMLInputElement;
it('keeps reference edits attached after changing prompt text', async () => {
  field('addReference').click();
  await vi.waitFor(() => expect(document.querySelector('#references input')).not.toBeNull());
  field('text').value = 'New draft'; field('text').dispatchEvent(new Event('input'));
  const name = document.querySelector('#references input')! as HTMLInputElement;
  name.value = 'person'; name.dispatchEvent(new Event('change')); await flush();
  expect(session.draft.references[0]!.id).toBe('person'); expect(session.draft.text).toBe('New draft');
});
it('does not silently submit edit inputs as generation', async () => {
  field('addReference').click(); await vi.waitFor(() => expect(document.querySelector('#references input')).not.toBeNull());
  field('text').value = 'Draft'; field('text').dispatchEvent(new Event('input'));
  expect(field('run').disabled).toBe(true);
  expect(document.getElementById('admission')!.textContent).toContain('Switch to Edit');
  field('run').click(); expect(call.mock.calls.some(([action]) => action === 'submit')).toBe(false);
});
it('changes interface language without changing authored draft content or selected models', async () => {
  field('text').value = '私の画像 prompt'; field('text').dispatchEvent(new Event('input')); await flush();
  field('settingsButton').click();
  await vi.waitFor(() => expect((document.getElementById('settings') as HTMLDialogElement).open).toBe(true));
  const original = call.getMockImplementation()!;
  let chosen = 'en';
  call.mockImplementation(async (action, payload) => {
    if (action === 'preferences') { chosen = payload.language; return; }
    const value = await original(action, payload);
    if (action === 'overview') return { ...value, locale: { language: chosen, format: chosen, systemLanguage: 'en' }, settings: { ...value.settings, language: chosen } };
    return value;
  });
  field('language').value = 'ja'; field('language').dispatchEvent(new Event('change', { bubbles: true })); field('saveSettingsDialog').click();
  await vi.waitFor(() => expect(document.documentElement.lang).toBe('ja'));
  expect(field('text').value).toBe('私の画像 prompt');
  expect(session.draft.modelIds).toEqual(['flux2-klein-4b-4bit']);
  expect(field('run').textContent).not.toBe('Generate');
  expect(field('settingsButton').textContent).not.toBe('Settings');
});

it('detects leaked message keys while accepting a user name that looks like a key', () => {
  const root = document.createElement('div'); root.innerHTML = '<button>ui.settings</button><div id="sessionList"><button>ui.settings</button></div>';
  expect(leakedMessages(root)).toEqual(['ui.settings']);
});

it('guards dirty settings dismissal and only saves valid changed values', async () => {
  field('settingsButton').focus(); field('settingsButton').click();
  await vi.waitFor(() => expect((field('settings') as unknown as HTMLDialogElement).open).toBe(true));
  expect(field('saveSettingsDialog').disabled).toBe(true);
  field('engineDirectory').value = 'relative'; field('engineDirectory').dispatchEvent(new Event('input', { bubbles: true }));
  expect(field('engineDirectory').getAttribute('aria-invalid')).toBe('true'); expect(field('saveSettingsDialog').disabled).toBe(true);
  field('engineDirectory').value = '/engine'; field('engineDirectory').dispatchEvent(new Event('input', { bubbles: true }));
  expect(field('saveSettingsDialog').disabled).toBe(false);
  menuCommand('closeWindow');
  await vi.waitFor(() => expect((field('appMessage') as unknown as HTMLDialogElement).open).toBe(true));
  expect(document.activeElement).toBe(field('messageCancel'));
  field('messageCancel').click();
  await vi.waitFor(() => expect((field('appMessage') as unknown as HTMLDialogElement).open).toBe(false));
  expect((field('settings') as unknown as HTMLDialogElement).open).toBe(true); expect(field('engineDirectory').value).toBe('/engine');
  await new Promise(resolve => setTimeout(resolve, 0));
  field('cancelSettings').click();
  await vi.waitFor(() => expect((field('appMessage') as unknown as HTMLDialogElement).open).toBe(true));
  (document.querySelector('#appMessage footer button:last-child') as HTMLButtonElement).click();
  await vi.waitFor(() => expect((field('settings') as unknown as HTMLDialogElement).open).toBe(false));
  expect(document.activeElement).toBe(field('settingsButton'));
  expect(call.mock.calls.some(([action]) => action === 'preferences' || action === 'closeWindow')).toBe(false);
});
it('keeps path-picker failures inside Settings and preserves its draft', async () => {
  field('settingsButton').click(); await vi.waitFor(() => expect((field('settings') as unknown as HTMLDialogElement).open).toBe(true));
  const original = call.getMockImplementation()!;
  call.mockImplementation(async (action, payload) => { if (action === 'pickPath') throw new Error('private diagnostic'); return original(action, payload); });
  field('choose-engineDirectory').click();
  await vi.waitFor(() => expect(field('settingsIssue').textContent).not.toBe(''));
  expect(field('issue').hidden).toBe(true); expect(field('manageIssue').textContent).toBe('');
});
it('does not run menu commands or dismiss a modal while an IME candidate is pending', async () => {
  field('text').dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
  menuCommand('settingsButton'); menuCommand('run');
  expect(call.mock.calls.some(([action]) => action === 'submit')).toBe(false);
  expect((field('settings') as unknown as HTMLDialogElement).open).toBe(false);
  field('text').dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
  await new Promise(requestAnimationFrame); menuCommand('settingsButton');
  await vi.waitFor(() => expect((field('settings') as unknown as HTMLDialogElement).open).toBe(true));
});

it('keeps the current editor when deletion or collection selection is cancelled', async () => {
  field('text').value = 'Keep this draft'; field('text').dispatchEvent(new Event('input')); await flush();
  const loads = call.mock.calls.filter(([action]) => action === 'get').length;
  field('delete').click(); await vi.waitFor(() => expect(call).toHaveBeenCalledWith('delete', { id: session.id }));
  field('collection').click(); await vi.waitFor(() => expect(call).toHaveBeenCalledWith('collection'));
  await flush(); expect(field('text').value).toBe('Keep this draft');
  expect(call.mock.calls.filter(([action]) => action === 'get')).toHaveLength(loads);
});

it('routes window quit through the dirty Settings decision without saving or closing the draft', async () => {
  field('settingsButton').click(); await vi.waitFor(() => expect((field('settings') as unknown as HTMLDialogElement).open).toBe(true));
  field('engineDirectory').value = '/unsaved'; field('engineDirectory').dispatchEvent(new Event('input', { bubbles: true }));
  menuCommand('beginClose'); menuCommand('closeWindow');
  expect((field('appMessage') as unknown as HTMLDialogElement).open).toBe(false);
  await flush();
  const decision = request({ kind: 'closeDrafts' });
  await vi.waitFor(() => expect((field('appMessage') as unknown as HTMLDialogElement).open).toBe(true));
  field('messageCancel').click(); expect(await decision).toBe(false);
  menuCommand('endClose');
  expect(field('engineDirectory').value).toBe('/unsaved'); expect(field('settings').inert).toBe(false);
  expect(call.mock.calls.some(([action]) => action === 'preferences')).toBe(false);
});
it('queues app messages, defaults to keeping work, and interrupts all pending decisions', async () => {
  const message = { title: { key: 'ui.delete_this_session_and_its_retained_images' }, actions: [{ label: { key: 'ui.keep_session' } }, { label: { key: 'ui.delete_session' }, destructive: true }] };
  const first = request({ kind: 'message', message }); const second = request({ kind: 'message', message });
  expect(document.activeElement).toBe(field('messageCancel'));
  expect(document.querySelector('#appMessage .danger')?.textContent).toBe('Delete session');
  menuCommand('shutdown'); expect(await first).toBeUndefined(); expect(await second).toBeUndefined();
  menuCommand('endClose');
});
it('waits for submitted Settings and retries only the submitted values after save failure', async () => {
  field('settingsButton').click(); await vi.waitFor(() => expect((field('settings') as unknown as HTMLDialogElement).open).toBe(true));
  const original = call.getMockImplementation()!; let fail = true;
  call.mockImplementation(async (action, payload) => { if (action === 'preferences' && fail) throw new Error('disk failed'); return original(action, payload); });
  field('engineDirectory').value = '/submitted'; field('engineDirectory').dispatchEvent(new Event('input', { bubbles: true }));
  field('saveSettingsDialog').click(); await vi.waitFor(() => expect(field('settingsIssue').textContent).not.toBe(''));
  field('engineDirectory').value = '/new-draft'; field('engineDirectory').dispatchEvent(new Event('input', { bubbles: true }));
  await expect(flush()).rejects.toThrow('disk failed'); fail = false; await flush();
  expect(call.mock.calls.filter(([action]) => action === 'preferences').map(([, payload]) => payload.engineDirectory)).toEqual(['/submitted', '/submitted']);
  expect(field('engineDirectory').value).toBe('/new-draft'); expect((field('settings') as unknown as HTMLDialogElement).open).toBe(true);
});
it('retires a failed Settings submission after explicit discard', async () => {
  field('settingsButton').click(); await vi.waitFor(() => expect((field('settings') as unknown as HTMLDialogElement).open).toBe(true));
  const original = call.getMockImplementation()!;
  call.mockImplementation(async (action, payload) => { if (action === 'preferences') throw new Error('disk failed'); return original(action, payload); });
  field('engineDirectory').value = '/discarded'; field('engineDirectory').dispatchEvent(new Event('input', { bubbles: true }));
  field('saveSettingsDialog').click(); await vi.waitFor(() => expect(field('settingsIssue').textContent).not.toBe(''));
  field('cancelSettings').click(); await vi.waitFor(() => expect((field('appMessage') as unknown as HTMLDialogElement).open).toBe(true));
  (document.querySelector('#appMessage footer button:last-child') as HTMLButtonElement).click();
  await vi.waitFor(() => expect((field('settings') as unknown as HTMLDialogElement).open).toBe(false));
  await flush(); expect(call.mock.calls.filter(([action]) => action === 'preferences')).toHaveLength(1);
});

it('opens the shortcut reference through its binding, lists real commands and closes only the modal', async () => {
  const { shortcuts, shortcutText } = await import('../../src/shared/shortcuts.ts');
  field('shortcutsButton').focus();
  field('shortcutsButton').dispatchEvent(new KeyboardEvent('keydown',{key:'/',ctrlKey:true,shiftKey:true,bubbles:true,cancelable:true}));
  expect((field('shortcuts') as unknown as HTMLDialogElement).open).toBe(true);
  expect([...document.querySelectorAll('#shortcuts dd')].map(row => row.textContent)).toEqual(shortcuts.map(entry => shortcutText(entry,/Mac/.test(navigator.platform))));
  expect(document.activeElement).toBe(field('closeShortcuts'));
  field('closeShortcuts').dispatchEvent(new KeyboardEvent('keydown',{key:'w',metaKey:true,bubbles:true,cancelable:true}));
  await vi.waitFor(() => expect((field('shortcuts') as unknown as HTMLDialogElement).open).toBe(false));
  expect(call.mock.calls.some(([action]) => action === 'closeWindow')).toBe(false);
  expect(document.activeElement).toBe(field('shortcutsButton'));
});
it('keeps workspace accelerators behind modal guards while Quit still uses the guarded close flow', async () => {
  menuCommand('settingsButton'); await vi.waitFor(() => expect((field('settings') as unknown as HTMLDialogElement).open).toBe(true));
  field('engineDirectory').dispatchEvent(new KeyboardEvent('keydown',{key:'n',metaKey:true,bubbles:true,cancelable:true}));
  expect(call.mock.calls.some(([action]) => action === 'create')).toBe(false);
  field('engineDirectory').dispatchEvent(new KeyboardEvent('keydown',{key:'q',metaKey:true,bubbles:true,cancelable:true}));
  expect(call).toHaveBeenCalledWith('closeWindow');
});
