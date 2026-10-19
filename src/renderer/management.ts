import type { Bridge } from '../shared/bridge.ts';
const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id)! as T;
const field = (id: string) => el<HTMLInputElement>(id);
/** Native dialogs choose paths; this surface only edits caller-owned SDK options. */
export function management(api: Bridge, changed: () => Promise<void>) {
  let overview: any; let busy = false;
  el('management').addEventListener('cancel', event => { if (busy) event.preventDefault(); });
  const dialog = el<HTMLDialogElement>('management');
  const components = ['checkpoint', 'vae', 'photoMaker', 'ipAdapter', 'clipVision', 'controlNet'] as const;
  let loras: { path: string; scale?: number }[] = [];
  function action(id: string, work: () => Promise<unknown> | void) {
    el(id).onclick = () => { void Promise.resolve().then(work).catch(error => { el('manageIssue').textContent = String(error); }); };
  }
  async function inventory() {
    const inventory = await api.call('models'); const list = el('managedList'); list.replaceChildren();
    for (const model of inventory.models) { const p = document.createElement('p'); p.textContent = `${model.id}: ${model.status}`; list.append(p); }
    for (const entry of inventory.entries) {
      const row = document.createElement('div'); row.className = 'row';
      const description = document.createElement('span'); description.textContent = `${entry.modelId} · ${entry.name.slice(0, 12)} · ${(entry.bytes / 1e9).toFixed(2)} GB`;
      const remove = document.createElement('button'); remove.textContent = 'Remove revision';
      remove.onclick = () => { void operation(() => api.call('removeManaged', { modelId: entry.modelId, name: entry.name })).catch(error => { el('manageIssue').textContent = String(error); }); };
      row.append(description, remove); list.append(row);
    }
    for (const id of Object.keys(overview.settings.registrations)) { const p = document.createElement('p'); p.textContent = `${id}: registered external selection`; list.append(p); }
  }
  async function operation(work: () => Promise<unknown>) {
    if (busy) throw new Error('A resource operation is already running.');
    busy = true; el('manageIssue').textContent = 'Working…'; el('cancelManaged').hidden = false;
    const buttons = [...dialog.querySelectorAll<HTMLButtonElement>('button')]; buttons.forEach(button => { button.disabled = button.id !== 'cancelManaged'; });
    try { const result = await work(); el('manageIssue').textContent = result === undefined ? '' : describe(result); overview = await api.call('overview'); await inventory(); await changed(); }
    finally { busy = false; el('cancelManaged').hidden = true; buttons.forEach(button => { button.disabled = false; }); selections(); }
  }
  function describe(result: any): string {
    if (result.mflux && result.native) return `Python engine: ${result.mflux.status}. Native engine: ${result.native.status}.`;
    if (result.status) return result.message ? `${result.status}: ${result.message}` : String(result.status);
    return 'Completed.';
  }
  function selections() {
    const selected = overview.models.find((model: any) => model.id === field('manageModel').value);
    const native = selected?.runtime.name === 'stable-diffusion.cpp';
    el('nativeComponents').hidden = !native;
    el('loraControls').hidden = !selected?.capabilities.loraFormats?.length && !loras.length;
    field('download').disabled = selected?.acquisition !== 'pinned';
  }
  function renderLoras() {
    el('loraList').replaceChildren();
    loras.forEach((lora, index) => {
      const row = document.createElement('div'); row.className = 'row';
      const name = document.createElement('span'); name.textContent = lora.path;
      const scale = document.createElement('input'); scale.type = 'number'; scale.step = 'any'; scale.placeholder = 'Scale 1'; scale.setAttribute('aria-label', `Scale for ${lora.path}`); scale.value = lora.scale === undefined ? '' : String(lora.scale);
      scale.oninput = () => { if (scale.value === '') delete lora.scale; else lora.scale = Number(scale.value); };
      const remove = document.createElement('button'); remove.textContent = 'Remove'; remove.onclick = () => { loras.splice(index, 1); renderLoras(); };
      row.append(name, scale, remove); el('loraList').append(row);
    });
  }
  action('manage', async () => {
    overview = await api.call('overview'); el('manageIssue').textContent = ''; dialog.showModal();
    const select = el<HTMLSelectElement>('manageModel'); select.replaceChildren();
    for (const model of overview.models) { const option = document.createElement('option'); option.value = model.id; option.textContent = model.id; select.append(option); }
    select.onchange = selections; selections(); await inventory();
  });
  action('cancelManaged', () => api.call('cancelManaged'));
  action('closeManagement', () => dialog.close());
  action('chooseBundle', async () => { const path = await api.call('pickPath'); if (path) { field('bundleDirectory').value = path; components.forEach(key => { field(`component-${key}`).value = ''; }); loras = []; renderLoras(); } });
  for (const key of components) action(`choose-${key}`, async () => { const path = await api.call('pickComponent', { directory: field('bundleDirectory').value }); if (path) field(`component-${key}`).value = path; });
  action('addLora', async () => { const path = await api.call('pickComponent', { directory: field('bundleDirectory').value }); if (path) { loras.push({ path }); renderLoras(); } });
  action('register', () => operation(() => {
    const extras: any = {};
    for (const key of components.filter(key => key !== 'checkpoint')) if (field(`component-${key}`).value) extras[key] = key === 'controlNet' ? { path: field(`component-${key}`).value, kind: 'canny' } : field(`component-${key}`).value;
    if (loras.length) extras.loras = loras;
    return api.call('prepare', { modelId: field('manageModel').value, directory: field('bundleDirectory').value || undefined, checkpoint: field('component-checkpoint').value || undefined, components: extras });
  }));
  action('download', () => operation(() => api.call('prepare', { modelId: field('manageModel').value, download: true })));
  action('verify', () => operation(() => api.call('verify', { modelId: field('manageModel').value })));
  for (const [id, command] of [['installNative','installNative'], ['installPython','installPython'], ['checkEngines','engines']] as const) action(id, () => operation(() => api.call(command)));

  action('showRecords', async () => { const items = await api.call('records'); el('recordLines').textContent = items.map((item: any) => JSON.stringify(item)).join('\n'); el<HTMLDialogElement>('records').showModal(); });
  action('closeRecords', () => el<HTMLDialogElement>('records').close());
  const settings = el<HTMLDialogElement>('settings');
  action('settingsButton', async () => {
    overview = await api.call('overview'); el('settingsIssue').textContent = '';
    for (const key of ['engineDirectory', 'modelsDirectory', 'nativeExecutable'] as const) { field(key).value = overview.settings.profile[key] ?? ''; field(key).placeholder = overview.locations[key] ?? 'Managed native engine'; }
    field('theme').value = overview.settings.theme ?? 'system';
    el('collectionLocation').textContent = overview.locations.sessionsDirectory;
    settings.showModal();
  });
  for (const key of ['engineDirectory', 'modelsDirectory', 'nativeExecutable']) action(`choose-${key}`, async () => { const path = await api.call('pickPath', { file: key === 'nativeExecutable' }); if (path) field(key).value = path; });
  action('cancelSettings', () => settings.close());
  el('saveSettingsDialog').onclick = () => { void (async () => {
    const value: any = {};
    for (const key of ['engineDirectory', 'modelsDirectory', 'nativeExecutable']) if (field(key).value.trim()) value[key] = field(key).value.trim();
    if (field('theme').value !== 'system') value.theme = field('theme').value;
    await api.call('preferences', value); await changed(); settings.close();
  })().catch(error => { el('settingsIssue').textContent = String(error); }); };
}
