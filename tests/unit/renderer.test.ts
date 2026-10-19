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
  window.picpatch = { call, onChange: () => () => {}, onCommand: () => () => {}, onFlush: listener => { flush = listener; }, droppedFile: () => '/fixture/photo.png' };
  await import('../../src/renderer/main.ts');
  await vi.waitFor(() => expect(call).toHaveBeenCalledWith('ready'));
});
afterEach(async () => { if (flush) await flush(); expect(leakedMessages(document.body)).toEqual([]); vi.restoreAllMocks(); document.body.replaceChildren(); });
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
  field('language').value = 'ja'; field('saveSettingsDialog').click();
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
