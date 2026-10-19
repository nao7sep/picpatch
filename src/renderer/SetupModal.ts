import { modal } from './Modal.ts';
import { t, number, errorText } from '../shared/i18n/index.ts';
import { modelName } from '../shared/model-name.ts';
import type { Bridge } from '../shared/bridge.ts';
/** Explicit acquisition steps. Opening or skipping setup never changes resources. */
export function setupModal(api: Bridge, changed: () => Promise<void>, selected: (id: string) => Promise<void>, manage: (id: string) => Promise<void>) {
  const el = <T extends HTMLElement>(id: string) => document.getElementById(id)! as T;
  const surface = el<HTMLDialogElement>('setup'), choice = el<HTMLSelectElement>('setupModel');
  const install = el<HTMLButtonElement>('setupInstall'), prepare = el<HTMLButtonElement>('setupPrepare');
  let engineReady = false, inspection = 0;
  let models: any[] = [], busy = false, states: Record<string, string> = {};
  const shell = modal(surface, el('skipSetup'), { canClose: () => !busy });
  function paint() {
    const model = models.find(model => model.id === choice.value);
    el('setupSize').textContent = model?.downloadBytes ? t('setup.size', { size: `${number(model.downloadBytes / 1e9, { maximumFractionDigits: 2 })} GB` }) : t('setup.local');
    install.disabled = busy || engineReady; prepare.disabled = busy || !engineReady; choice.disabled = busy;
    el<HTMLButtonElement>('skipSetup').disabled = busy; el<HTMLButtonElement>('finishSetup').disabled = busy || states[choice.value] !== 'ready';
    el('setupCancel').hidden = !busy;
    el('setupState').textContent = busy ? t('ui.working') : t(`model.${states[choice.value] ?? 'missing'}`);
  }
  async function inspect() {
    const revision = ++inspection; engineReady = false; paint();
    try {
      const engines = await api.call('engines', { modelId: choice.value });
      if (revision !== inspection) return;
      engineReady = (models.find(model => model.id === choice.value)?.runtime.name === 'stable-diffusion.cpp' ? engines.native : engines.python).status === 'ready';
    } catch (error) { if (revision === inspection) el('setupIssue').textContent = errorText(error); }
    if (revision === inspection) paint();
  }
  async function run(action: string, payload: unknown) {
    if (busy) return; busy = true; el('setupIssue').textContent = ''; paint();
    try { await api.call(action, payload); states = await api.call('modelReadiness'); await inspect(); await changed(); }
    catch (error) { el('setupIssue').textContent = errorText(error); }
    finally { busy = false; paint(); }
  }
  choice.onchange = () => { void inspect(); };
  install.onclick = () => { const model = models.find(model => model.id === choice.value); void run(model?.runtime.name === 'stable-diffusion.cpp' ? 'installNative' : 'installPython', { modelId: choice.value }); };
  prepare.onclick = () => {
    const model = models.find(model => model.id === choice.value);
    if (model?.acquisition === 'pinned') void run('prepare', { modelId: choice.value, download: true });
    else { const id = choice.value; shell.close(); void manage(id).catch(error => { el('setupIssue').textContent = errorText(error); shell.open(); }); }
  };
  el('setupCancel').onclick = () => { void api.call('cancelManaged').catch(error => { el('setupIssue').textContent = errorText(error); }); };
  el('finishSetup').onclick = () => {
    if (busy || states[choice.value] !== 'ready') return;
    busy = true; paint();
    void selected(choice.value).then(() => shell.close(), error => { el('setupIssue').textContent = errorText(error); }).finally(() => { busy = false; paint(); });
  };
  return async () => {
    const overview = await api.call('overview'); models = overview.models; states = await api.call('modelReadiness');
    choice.replaceChildren();
    for (const model of models) { const option = document.createElement('option'); option.value = model.id; option.textContent = modelName(model.id); choice.append(option); }
    el('setupIssue').textContent = ''; paint(); shell.open(); await inspect();
  };
}
