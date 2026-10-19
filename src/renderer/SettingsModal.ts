import { languageOptions } from './localization.ts';
import { t, errorText, message } from '../shared/i18n/index.ts';
import { modal } from './Modal.ts';
import type { messageModal } from './MessageModal.ts';
import type { Bridge } from '../shared/bridge.ts';
const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id)! as T;
const field = (id: string) => el<HTMLInputElement>(id);
export function settingsModal(api: Bridge, changed: () => Promise<void>, messages: ReturnType<typeof messageModal>) {
  const surface = el<HTMLDialogElement>('settings');
  const paths = ['engineDirectory', 'modelsDirectory', 'nativeExecutable'] as const;
  const confirmDiscard = async () => await messages.ask({ title: message('ui.discard_unsaved_settings'), actions: [{ label: message('ui.cancel') }, { label: message('ui.discard_changes'), destructive: true }] }) === 1;
  let save: Promise<void> | undefined;
  let retry: (() => Promise<void>) | undefined;
  let failedAtClose = false;
  let initial = ''; let saving = false;
  const snapshot = () => JSON.stringify([...paths, 'theme', 'language'].map(key => field(key).value));
  const shell = modal(surface, el('cancelSettings'), { focus: () => field('engineDirectory'), canClose: async () => {
    if (saving) return false;
    if (snapshot() !== initial && !await confirmDiscard()) return false;
    save = undefined; retry = undefined; failedAtClose = false;
    return true;
  } });
  function validate() {
    let valid = true;
    for (const key of paths) {
      const value = field(key).value.trim();
      const absolute = !value || (/Win/.test(navigator.platform) ? /^(?:[a-z]:[\\/]|\\\\)/i.test(value) : value.startsWith('/'));
      field(key).setAttribute('aria-invalid', String(!absolute));
      if (!absolute) field(key).setAttribute('aria-describedby', 'settingsIssue'); else field(key).removeAttribute('aria-describedby');
      valid &&= absolute;
    }
    el('settingsIssue').textContent = valid ? '' : t('error.stored_resource_paths_must_be_absolute');
    field('saveSettingsDialog').disabled = saving || !valid || snapshot() === initial;
  }
  surface.addEventListener('input', validate); surface.addEventListener('change', validate);
  function report(error: unknown) { el('settingsIssue').textContent = errorText(error); }
  el('settingsButton').onclick = () => { void (async () => {
    const overview = await api.call('overview');
    for (const key of paths) { field(key).value = overview.settings.profile[key] ?? ''; field(key).placeholder = overview.locations[key] ?? t('ui.managed_native_engine'); }
    el('theme').querySelector<HTMLOptionElement>('[value=system]')!.textContent = overview.settings.theme ? t('ui.system') : t('settings.system', { value: t(matchMedia('(prefers-color-scheme: dark)').matches ? 'ui.dark' : 'ui.light') });
    field('theme').value = overview.settings.theme ?? 'system';
    languageOptions(el('language'), overview.locale?.systemLanguage ?? 'en'); field('language').value = overview.settings.language ?? 'system';
    el('collectionLocation').textContent = overview.locations.sessionsDirectory;
    initial = snapshot(); validate(); shell.open();
  })().catch(error => { field('saveSettingsDialog').disabled = true; shell.open(); report(error); }); };
  for (const key of paths) el(`choose-${key}`).onclick = () => { void api.call('pickPath', { file: key === 'nativeExecutable' }).then(path => { if (path) { field(key).value = path; validate(); } }).catch(report); };
  el('saveSettingsDialog').onclick = () => {
    if (saving || field('saveSettingsDialog').disabled) return;
    const value: Record<string, string> = {};
    for (const key of paths) if (field(key).value.trim()) value[key] = field(key).value.trim();
    if (field('language').value !== 'system') value.language = field('language').value;
    if (field('theme').value !== 'system') value.theme = field('theme').value;
    const submitted = snapshot();
    retry = async () => {
      saving = true;
      const controls = [...surface.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>('input,button,select')];
      controls.forEach(control => { control.disabled = true; });
      try {
        await api.call('preferences', value); initial = submitted; await changed();
        if (snapshot() === submitted) shell.close();
        retry = undefined;
      } finally { saving = false; controls.forEach(control => { control.disabled = false; }); validate(); }
    };
    failedAtClose = false; save = retry(); void save.catch(report);
  };
  return {
    async settleSave() {
      // Retry only the explicitly submitted values, never a subsequently edited draft.
      if (failedAtClose && retry) { save = retry(); void save.catch(report); }
      try { await save; failedAtClose = false; }
      catch (error) { failedAtClose = true; throw error; }
    },
    async approveQuit() { return !surface.open || snapshot() === initial || confirmDiscard(); },
  };
}
