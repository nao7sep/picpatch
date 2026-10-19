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
let changed: () => void;
let menuCommand: (id: string) => void;
beforeEach(async () => {
  vi.resetModules();
  document.write((await readFile(`${process.cwd()}/src/renderer/index.html`, 'utf8')).replace(/<link[^>]*>/g, '').replace(/<script[\s\S]*?<\/script>/g, ''));
  const canvas = { clearRect: vi.fn(), drawImage: vi.fn(), getImageData: vi.fn(), putImageData: vi.fn() };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(canvas as never);
  session = { version: 1, id: '11111111-1111-4111-8111-111111111111', name: 'Test', created: new Date().toISOString(), updated: new Date().toISOString(), assets: [], runs: [], draft: initialDraft() };
  call = vi.fn(async (action: string, payload?: any) => {
    if (action === 'engines') return { python: { status: 'ready' }, native: { status: 'missing' } };
    if (action === 'modelReadiness') return Object.fromEntries(models.map(model => [model.id, 'ready']));
    if (action === 'paneState') return { requestWidth: 300, sidebar: false };
    if (action === 'overview') return { sessions: [session], failures: [], models, queue: { paused: false }, settings: { profile: { version: 1 }, registrations: {} }, locations: {} };
    if (action === 'get') return structuredClone(session);
    if (action === 'draft') { session.draft = structuredClone(payload.draft); session.selection = payload.selection; return session; }
    if (action === 'import') { const asset = { id: '22222222-2222-4222-8222-222222222222', name: 'photo.png', file: 'assets/photo.png', bytes: 1, sha256: '0'.repeat(64) }; session.assets.push(asset); return [asset]; }
    if (action === 'submit') {
      const run = { id: '33333333-3333-4333-8333-333333333333', modelId: payload.draft.modelIds[0], seed: 42, draft: structuredClone(payload.draft), status: 'queued' as const, created: new Date().toISOString() };
      session.runs.push(run); return [run];
    }
  });
  window.picpatch = { call, onChange: listener => { changed = listener; return () => {}; }, onCommand: listener => { menuCommand = listener; return () => {}; }, onRequest: listener => { flush = async () => { await listener({ kind: 'flush' }); }; request = listener; }, droppedFile: () => '/fixture/photo.png' };
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
it('uses attached references as explicit edit inputs without a mode switch', async () => {
  field('addReference').click(); await vi.waitFor(() => expect(document.querySelector('#references input')).not.toBeNull());
  field('text').value = 'Draft'; field('text').dispatchEvent(new Event('input'));
  expect(field('run').disabled).toBe(false);
  field('run').click();
  await vi.waitFor(() => expect(call).toHaveBeenCalledWith('submit', expect.objectContaining({ draft: expect.objectContaining({ mode: 'edit', text: 'Draft' }) })));
  await flush();
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
  expect(document.activeElement).toBe(field('menuButton'));
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
  expect([...document.querySelectorAll('#shortcuts dl:first-of-type dd')].map(row => row.textContent)).toEqual(shortcuts.map(entry => shortcutText(entry,/Mac/.test(navigator.platform))));
  expect(document.activeElement).toBe(field('closeShortcuts'));
  field('closeShortcuts').dispatchEvent(new KeyboardEvent('keydown',{key:'w',metaKey:true,bubbles:true,cancelable:true}));
  await vi.waitFor(() => expect((field('shortcuts') as unknown as HTMLDialogElement).open).toBe(false));
  expect(call.mock.calls.some(([action]) => action === 'closeWindow')).toBe(false);
  expect(document.activeElement).toBe(field('menuButton'));
});
it('keeps workspace accelerators behind modal guards while Quit still uses the guarded close flow', async () => {
  menuCommand('settingsButton'); await vi.waitFor(() => expect((field('settings') as unknown as HTMLDialogElement).open).toBe(true));
  field('engineDirectory').dispatchEvent(new KeyboardEvent('keydown',{key:'n',metaKey:true,bubbles:true,cancelable:true}));
  expect(call.mock.calls.some(([action]) => action === 'create')).toBe(false);
  field('engineDirectory').dispatchEvent(new KeyboardEvent('keydown',{key:'q',metaKey:true,bubbles:true,cancelable:true}));
  expect(call).toHaveBeenCalledWith('closeWindow');
});
it('applies font only on Save and shows the independent system theme', async () => {
  const original = call.getMockImplementation()!; let family: string | undefined;
  call.mockImplementation(async (action,payload) => {
    if (action === 'preferences') { family = payload.uiFont; return; }
    const value = await original(action,payload);
    if (action === 'overview') return {...value, systemDark:true, settings:{...value.settings, theme:'light', uiFont:family}};
    return value;
  });
  field('settingsButton').click(); await vi.waitFor(() => expect((field('settings') as unknown as HTMLDialogElement).open).toBe(true));
  expect(field('systemTheme').textContent).toContain('Dark');
  const before = document.documentElement.style.getPropertyValue('--font-ui');
  field('uiFont').value = 'Arial, sans-serif'; field('uiFont').dispatchEvent(new Event('input',{bubbles:true}));
  expect(document.documentElement.style.getPropertyValue('--font-ui')).toBe(before);
  field('saveSettingsDialog').click(); await vi.waitFor(() => expect(document.documentElement.style.getPropertyValue('--font-ui')).toBe('Arial, sans-serif'));
  expect(family).toBe('Arial, sans-serif');
});
it('routes interface zoom separately from the canvas zoom control', () => {
  const before = field('zoom').value;
  menuCommand('uiZoomIn'); expect(call).toHaveBeenCalledWith('uiZoom',{direction:'in'});
  expect(field('zoom').value).toBe(before);
});
it('keeps management failures while unrelated progress and success occur', async () => {
  const original = call.getMockImplementation()!;
  let finish!: (value: unknown) => void;
  call.mockImplementation(async (action,payload) => {
    if (action === 'overview') { const value = await original(action,payload); return {...value,models:models.map(model=>({...model,runtime:{name:'mflux'}}))}; }
    if (action === 'models') return {models:[],entries:[]};
    if (action === 'verify') throw new Error('EACCES /private/SENTINEL');
    if (action === 'installPython') return new Promise(resolve => {finish = resolve;});
    return original(action,payload);
  });
  field('manage').click(); await vi.waitFor(() => expect(field('manageModel').children).toHaveLength(1)); field('manageModel').value = models[0]!.id;
  field('verify').click(); await vi.waitFor(() => expect(field('manageIssue').children).toHaveLength(1));
  const failure = field('manageIssue').textContent;
  field('installPython').click(); await vi.waitFor(() => expect(field('manageStatus').textContent).toContain('Working'));
  expect(field('manageIssue').textContent).toBe(failure); expect(field('manageIssue').textContent).not.toContain('SENTINEL');
  finish({status:'ready'}); await vi.waitFor(() => expect(field('installPython').disabled).toBe(false));
  expect(field('manageIssue').textContent).toBe(failure); expect(field('issue').hidden).toBe(true);
});
it('routes a source drop through import and clears its own batch refusal after correction', async () => {
  const drop = (names: string[]) => {
    const data = new DataTransfer(); Object.defineProperty(data,'types',{get:()=>['Files']});
    for (const name of names) data.items.add(new File(['fixture'],name,{type:'image/png'}));
    const event = new DragEvent('drop',{bubbles:true,cancelable:true}); Object.defineProperty(event,'dataTransfer',{value:data}); field('canvas').dispatchEvent(event);
  };
  drop(['a.png','b.png']); expect(field('requestIssues').children).toHaveLength(1);
  expect(call.mock.calls.some(([action]) => action === 'import')).toBe(false);
  drop(['a.png']); await vi.waitFor(() => expect(session.draft.source).toBe('22222222-2222-4222-8222-222222222222'));
  expect(call).toHaveBeenCalledWith('import',{id:session.id,path:'/fixture/photo.png'});
  expect(session.draft.mode).toBe('edit'); expect(field('requestIssues').hidden).toBe(true);
});
it('shows app-owned About metadata and routes only its fixed project links', async () => {
  const { about } = await import('../../src/shared/about.ts');
  const metadata = JSON.parse(await readFile('package.json','utf8'));
  menuCommand('about');
  expect((field('about') as unknown as HTMLDialogElement).open).toBe(true);
  expect(field('aboutIdentity').textContent).toBe(`${metadata.productName} ${metadata.version}`);
  expect(field('aboutCopyright').textContent).toBe(about.copyright);
  const links = [...document.querySelectorAll<HTMLAnchorElement>('#aboutLinks a')];
  expect(links.map(link=>link.href)).toEqual([about.repository,about.issues]);
  links[1]!.click(); expect(call).toHaveBeenCalledWith('openProjectLink',{destination:'issues'});
  field('closeAbout').click(); await vi.waitFor(()=>expect((field('about') as unknown as HTMLDialogElement).open).toBe(false));
});

it('keeps a prepared map modality and strength through draft edits', async () => {
  const capabilities = models[0]!.capabilities as typeof models[number]['capabilities'] & { controlKinds?: string[] };
  capabilities.controlKinds = ['canny', 'depth', 'pose'];
  try {
    field('controlKind').value = 'depth'; field('controlKind').dispatchEvent(new Event('change'));
    expect(field('addControl').disabled).toBe(false);
    field('addControl').click();
    await vi.waitFor(() => expect(call.mock.calls.some(([action]) => action === 'import')).toBe(true));
    await flush();
    expect(session.draft.control?.kind).toBe('depth');
    field('controlKind').value = 'pose'; field('controlKind').dispatchEvent(new Event('change'));
    field('controlStrength').value = '0.45'; field('controlStrength').dispatchEvent(new Event('input'));
    field('text').value = 'Authored text'; field('text').dispatchEvent(new Event('input')); await flush();
    expect(session.draft.control).toMatchObject({ kind: 'pose', strength: 0.45 });
    expect(session.draft.text).toBe('Authored text');
  } finally { delete capabilities.controlKinds; }
});
it('passes selected native text encoders through local model registration', async () => {
  const previous = call.getMockImplementation()!;
  call.mockImplementation(async (action, payload) => {
    if (action === 'overview') return { ...await previous(action, payload), models: [{ id: 'sd35-large', variant: 'sd35-large', runtime: { name: 'stable-diffusion.cpp' }, acquisition: 'external', capabilities: {} }] };
    if (action === 'models') return { models: [], entries: [] };
    if (action === 'pickComponent') return 'encoders/clip-l.safetensors';
    return previous(action, payload);
  });
  field('manage').click();
  await vi.waitFor(() => expect(document.querySelector('#manageModel option')?.getAttribute('value')).toBe('sd35-large'));
  field('manageModel').value = 'sd35-large'; field('manageModel').dispatchEvent(new Event('change'));
  expect(field('textEncoderComponents').hidden).toBe(false);
  field('bundleDirectory').value = '/models/local';
  field('choose-clipL').click();
  await vi.waitFor(() => expect(field('component-clipL').value).toBe('encoders/clip-l.safetensors'));
  field('component-clipG').value = 'encoders/clip-g.safetensors';
  field('component-t5').value = 'encoders/t5.safetensors';
  field('component-checkpoint').value = 'sd35.safetensors';
  field('register').click();
  await vi.waitFor(() => expect(call).toHaveBeenCalledWith('prepare', expect.objectContaining({ modelId: 'sd35-large', components: { clipL: 'encoders/clip-l.safetensors', clipG: 'encoders/clip-g.safetensors', t5: 'encoders/t5.safetensors' } })));
});

it('keeps the next instruction during inference, selects earlier images to branch and starts independent commands', async () => {
  field('text').value = 'A garden'; field('text').dispatchEvent(new Event('input')); field('run').click();
  await vi.waitFor(() => expect(field('text').value).toBe(''));
  expect(field('sourceName').textContent).toContain('Image 1');
  field('text').value = 'Add a bench'; field('text').dispatchEvent(new Event('input'));
  expect(field('run').disabled).toBe(true);
  expect(field('admission').textContent).toContain('not ready');
  session.runs[0]!.output = 'outputs/first.png'; session.runs[0]!.status = 'completed'; changed();
  await vi.waitFor(() => expect(field('run').disabled).toBe(false));
  expect(field('text').value).toBe('Add a bench'); expect(field('paint').disabled).toBe(false);
  expect(field('results').textContent).toContain('A garden');
  field('clearSource').click(); await vi.waitFor(() => expect(field('sourceName').textContent).toBe('Create a new image'));
  expect(field('text').value).toBe('Add a bench');
  (document.querySelector('#results button') as HTMLButtonElement).click();
  await vi.waitFor(() => expect(field('sourceName').textContent).toContain('Image 1'));
  await flush();
  expect(session.draft.source).toBe(session.runs[0]!.id); expect(session.selection).toEqual([session.runs[0]!.id]);
  expect(session.draft.text).toBe('Add a bench'); expect(session.runs).toHaveLength(1);
});

it('keeps a failed command and its attachments for correction, and never consumes the draft when submission fails', async () => {
  field('addReference').click(); await vi.waitFor(() => expect(session.assets).toHaveLength(1));
  field('text').value = 'ui.settings'; field('text').dispatchEvent(new Event('input'));
  const previous = call.getMockImplementation()!;
  call.mockImplementation(async (action, payload) => { if (action === 'submit') throw new Error('Unavailable'); return previous(action, payload); });
  field('run').click(); await vi.waitFor(() => expect(field('requestIssues').hidden).toBe(false));
  expect(field('text').value).toBe('ui.settings'); expect(document.querySelector('#references img')).not.toBeNull();
  expect(session.runs).toHaveLength(0);
  const literal = document.createElement('div'); literal.innerHTML = '<div id="results"><div class="commandText">ui.settings</div><span>conversation.send</span></div>';
  expect(leakedMessages(literal)).toEqual(['conversation.send']);
});

it.each(['failed', 'refused', 'cancelled', 'interrupted'] as const)('restores a runnable command after a %s result', async status => {
  field('text').value = 'A blue teapot'; field('text').dispatchEvent(new Event('input'));
  field('run').click();
  await vi.waitFor(() => expect(session.runs).toHaveLength(1));
  await vi.waitFor(() => expect(field('text').value).toBe(''));
  session.runs[0]!.status = status;
  changed();
  await vi.waitFor(() => expect(field('text').value).toBe('A blue teapot'));
  expect(field('run').disabled).toBe(false);
  expect(document.getElementById('admission')!.textContent).not.toContain('Wait');
  await flush(); expect(session.draft.source).toBeUndefined();
});
it('reverts an empty session name without poisoning draft saves', async () => {
  field('sessionName').value = ' '; field('sessionName').dispatchEvent(new Event('input'));
  field('sessionName').dispatchEvent(new Event('blur'));
  field('text').value = 'Preserved draft'; field('text').dispatchEvent(new Event('input'));
  await flush();
  expect(field('sessionName').value).toBe('Test'); expect(session.draft.text).toBe('Preserved draft');
  expect(call.mock.calls.some(([action]) => action === 'rename')).toBe(false);
});
it('offers comparison only for two completed results', async () => {
  expect(field('compare').disabled).toBe(true);
  expect(field('compareMode').hidden).toBe(true);
  expect(field('resume').hidden).toBe(true);
});
it('navigates the app menu without activating commands and returns to its trigger', async () => {
  field('menuButton').click();
  expect(document.activeElement).toBe(field('new'));
  field('new').dispatchEvent(new KeyboardEvent('keydown', { key:'ArrowDown', bubbles:true }));
  expect(document.activeElement).toBe(field('settingsButton'));
  expect((field('settings') as unknown as HTMLDialogElement).open).toBe(false);
  field('settingsButton').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
  expect(field('appMenu').hidden).toBe(true); expect(document.activeElement).toBe(field('menuButton'));
  field('menuButton').click(); field('settingsButton').click();
  await vi.waitFor(() => expect((field('settings') as unknown as HTMLDialogElement).open).toBe(true));
  expect(field('appMenu').hidden).toBe(true);
});
it('keeps Settings tab navigation and font reset inside its unsaved draft', async () => {
  field('settingsButton').click();
  await vi.waitFor(() => expect((field('settings') as unknown as HTMLDialogElement).open).toBe(true));
  field('generalTab').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));
  expect(document.activeElement).toBe(field('resourcesTab')); expect(field('generalSettings').hidden).toBe(true);
  field('generalTab').click(); field('uiFont').value='Example'; field('uiFont').dispatchEvent(new Event('input',{bubbles:true}));
  field('resetFonts').click(); expect(field('uiFont').value).toBe(''); expect(field('saveSettingsDialog').disabled).toBe(true);
  expect(call.mock.calls.some(([action]) => action === 'preferences')).toBe(false);
  field('uiFont').value='Example'; field('uiFont').dispatchEvent(new Event('input',{bubbles:true}));
  (document.querySelector('#settings .modalClose') as HTMLButtonElement).click();
  await vi.waitFor(() => expect((field('appMessage') as unknown as HTMLDialogElement).open).toBe(true));
});
it('asks for sidecar privacy each time and dismissal does not export', async () => {
  const run = { id: '33333333-3333-4333-8333-333333333333', modelId: models[0]!.id, seed: 1, draft: structuredClone(session.draft), status: 'completed' as const, created: new Date().toISOString(), output: 'output.png' };
  session.runs.push(run as never); session.selection = [run.id]; changed();
  await vi.waitFor(() => expect(document.querySelector('#results [role=option]')).not.toBeNull());
  (document.querySelector('#results [role=option]') as HTMLButtonElement).click();
  await vi.waitFor(() => expect(field('saveSettings').disabled).toBe(false));
  field('saveSettings').click(); await vi.waitFor(() => expect((field('exportOptions') as unknown as HTMLDialogElement).open).toBe(true));
  expect(field('includePrompts').checked).toBe(false);
  field('cancelExport').click(); await vi.waitFor(() => expect((field('exportOptions') as unknown as HTMLDialogElement).open).toBe(false));
  expect(call.mock.calls.some(([action]) => action === 'export')).toBe(false);
  field('saveSettings').click(); await vi.waitFor(() => expect((field('exportOptions') as unknown as HTMLDialogElement).open).toBe(true));
  field('includePrompts').checked = true; field('confirmExport').click();
  await vi.waitFor(() => expect(call).toHaveBeenCalledWith('export', expect.objectContaining({ runId: run.id, sidecar: true, includeInputs: true })));
});
it('opens explicit setup without acquisitions and refuses known unready choices', async () => {
  const original = call.getMockImplementation()!;
  call.mockImplementation(async (action, payload) => action === 'modelReadiness' ? { [models[0]!.id]: 'missing' } : original(action, payload));
  field('fixModels').click(); await vi.waitFor(() => expect((field('setup') as unknown as HTMLDialogElement).open).toBe(true));
  expect(call.mock.calls.some(([action]) => ['prepare','installPython','installNative'].includes(action))).toBe(false);
  field('skipSetup').click(); await vi.waitFor(() => expect((field('setup') as unknown as HTMLDialogElement).open).toBe(false));
});
it('keeps mask undo keys scoped to the focused painting canvas', async () => {
  field('import').click(); await vi.waitFor(() => expect(field('paint').disabled).toBe(false));
  field('paint').click(); await vi.waitFor(() => expect(field('mask').classList.contains('painting')).toBe(true));
  field('mask').focus();
  const undo = new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }); field('mask').dispatchEvent(undo);
  expect(undo.defaultPrevented).toBe(true);
  field('text').focus(); const textUndo = new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }); field('text').dispatchEvent(textUndo);
  expect(textUndo.defaultPrevented).toBe(false);
});
