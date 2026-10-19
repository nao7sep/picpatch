import { operationResults } from './operation-results.ts';
import { modal } from './Modal.ts';
import { t, term, number, errorText, UiError } from '../shared/i18n/index.ts';
import type { Bridge } from '../shared/bridge.ts';
const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id)! as T;
const field = (id: string) => el<HTMLInputElement>(id);
/** Native dialogs choose paths; this surface only edits caller-owned SDK options. */
export function managementModal(api: Bridge, changed: () => Promise<void>) {
  let overview: any; let busy = false;
  const dialog = el<HTMLDialogElement>('management');
  const issues = operationResults(el('manageIssue'));
  async function attempt(key: string, work: () => Promise<unknown> | void, label?: () => string) {
    try { const result: any = await work(); if (result?.status === 'refused') issues.show(key, result, label); else issues.clear(key); }
    catch (error) { issues.show(key, error, label); }
  }
  const shell = modal(dialog, el('closeManagement'), { canClose: () => !busy, focus: () => el('manageModel') });
  const components = ['checkpoint', 'vae', 'photoMaker', 'ipAdapter', 'clipVision', 'controlNet'] as const;
  let loras: { path: string; scale?: number }[] = [];
  function action(id: string, work: () => Promise<unknown> | void) {
    el(id).onclick = () => { const model = ['register','download','verify'].includes(id) ? field('manageModel').value : ''; const key = `${id}:${model}`; const label = el(id).dataset.i18n; void attempt(key, work, label ? () => model ? t('common.status', { name: model, status: t(label) }) : t(label) : undefined); };
  }
  async function inventory() {
    const inventory = await api.call('models'); const list = el('managedList'); list.replaceChildren();
    for (const model of inventory.models) { const p = document.createElement('p'); p.textContent = t('common.status', { name: model.id, status: term('status', model.status) }); list.append(p); }
    for (const entry of inventory.entries) {
      const row = document.createElement('div'); row.className = 'row';
      const description = document.createElement('span'); description.textContent = t('management.entry', { model: entry.modelId, revision: entry.name.slice(0, 12), size: number(entry.bytes / 1e9, { maximumFractionDigits: 2 }) });
      const remove = document.createElement('button'); remove.textContent = t('ui.remove_revision');
      remove.onclick = () => { void attempt(`remove:${entry.modelId}:${entry.name}`, () => operation(() => api.call('removeManaged', { modelId: entry.modelId, name: entry.name })), () => t('common.status', { name: entry.modelId, status: t('ui.remove_revision') })); };
      row.append(description, remove); list.append(row);
    }
    for (const id of Object.keys(overview.settings.registrations)) { const p = document.createElement('p'); p.textContent = t('management.external', { model: id }); list.append(p); }
  }
  async function operation(work: () => Promise<unknown>) {
    if (busy) throw new UiError('ui.a_resource_operation_is_already_running');
    busy = true; el('manageStatus').textContent = t('ui.working'); el('cancelManaged').hidden = false;
    const buttons = [...dialog.querySelectorAll<HTMLButtonElement>('button')]; buttons.forEach(button => { button.disabled = button.id !== 'cancelManaged'; });
    try { const result = await work(); el('manageStatus').textContent = result === undefined || (result as any)?.status === 'refused' ? '' : describe(result); await attempt('inventory', async () => { overview = await api.call('overview'); await inventory(); }); await attempt('workspace', changed); return result; }
    catch (error) { el('manageStatus').textContent = ''; throw error; }
    finally { busy = false; el('cancelManaged').hidden = true; buttons.forEach(button => { button.disabled = false; }); selections(); }
  }
  function describe(result: any): string {
    if (result.mflux && result.native) return t('management.engines', { python: term('status', result.mflux.status), native: term('status', result.native.status) });
    if (result.status) return result.status === 'refused' ? t('common.detail', { status: term('status', result.status), detail: errorText(result) }) : term('status', result.status);
    return t('ui.completed');
  }
  function selections() {
    const selected = overview?.models.find((model: any) => model.id === field('manageModel').value);
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
      const scale = document.createElement('input'); scale.type = 'number'; scale.step = 'any'; scale.placeholder = t('ui.scale_1'); scale.setAttribute('aria-label', t('management.scale', { name: lora.path })); scale.value = lora.scale === undefined ? '' : String(lora.scale);
      scale.oninput = () => { if (scale.value === '') delete lora.scale; else lora.scale = Number(scale.value); };
      const remove = document.createElement('button'); remove.textContent = t('ui.remove'); remove.onclick = () => { loras.splice(index, 1); renderLoras(); };
      row.append(name, scale, remove); el('loraList').append(row);
    });
  }
  action('manage', async () => {
    shell.open(); issues.localize(); overview = await api.call('overview');
    const select = el<HTMLSelectElement>('manageModel'); select.replaceChildren();
    for (const model of overview.models) { const option = document.createElement('option'); option.value = model.id; option.textContent = model.id; select.append(option); }
    select.onchange = selections; selections(); renderLoras(); await inventory();
  });
  action('cancelManaged', () => api.call('cancelManaged'));
  action('chooseBundle', async () => { const path = await api.call('pickPath'); if (path) { field('bundleDirectory').value = path; components.forEach(key => { field(`component-${key}`).value = ''; }); loras = []; renderLoras(); } });
  for (const key of components) {
    action(`choose-${key}`, async () => { const path = await api.call('pickComponent', { directory: field('bundleDirectory').value }); if (path) field(`component-${key}`).value = path; });
    if (key !== 'checkpoint') {
      const clear = document.createElement('button'); clear.dataset.i18n = 'ui.clear'; clear.dataset.componentClear = key; clear.textContent = t('ui.clear'); clear.setAttribute('aria-label', t('management.clear', { name: term('component', key) }));
      clear.onclick = () => { field(`component-${key}`).value = ''; }; el(`choose-${key}`).after(clear);
    }
  }
  action('addLora', async () => { const path = await api.call('pickComponent', { directory: field('bundleDirectory').value }); if (path) { loras.push({ path }); renderLoras(); } });
  action('register', () => operation(() => {
    const extras: any = {};
    for (const key of components.filter(key => key !== 'checkpoint')) if (field(`component-${key}`).value) extras[key] = key === 'controlNet' ? { path: field(`component-${key}`).value, kind: field('component-controlKind').value } : field(`component-${key}`).value;
    if (loras.length) extras.loras = loras;
    return api.call('prepare', { modelId: field('manageModel').value, directory: field('bundleDirectory').value || undefined, checkpoint: field('component-checkpoint').value || undefined, components: extras });
  }));
  action('download', () => operation(() => api.call('prepare', { modelId: field('manageModel').value, download: true })));
  action('verify', () => operation(() => api.call('verify', { modelId: field('manageModel').value })));
  for (const [id, command] of [['installNative','installNative'], ['installPython','installPython'], ['checkEngines','engines']] as const) action(id, () => operation(() => api.call(command)));

}
