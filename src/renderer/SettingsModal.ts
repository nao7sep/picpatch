import { isComposing } from './ime.ts';
import { defaultFont } from '../shared/appearance.ts';
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
  let initial = ''; let saving = false; let resourcesBusy = false;
  function lockResources() { for (const key of paths) { field(key).disabled = resourcesBusy; field(`choose-${key}`).disabled = resourcesBusy; } }
  const snapshot = () => JSON.stringify([...paths, 'theme', 'language', 'uiFont'].map(key => field(key).value));
  const shell = modal(surface, el('cancelSettings'), { focus: () => field('uiFont'), canClose: async () => {
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
  const tabs = [el<HTMLButtonElement>('generalTab'), el<HTMLButtonElement>('resourcesTab')];
  function selectTab(index: number) {
    tabs.forEach((tab, position) => { const selected = index === position; tab.tabIndex = selected ? 0 : -1; tab.setAttribute('aria-selected', String(selected)); el(tab.getAttribute('aria-controls')!).hidden = !selected; });
  }
  tabs.forEach((tab, index) => {
    tab.onclick = () => selectTab(index);
    tab.onkeydown = event => {
      if (isComposing(event) || !['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
      event.preventDefault(); const next = event.key === 'Home' ? 0 : event.key === 'End' ? 1 : Math.max(0, Math.min(1, index + (event.key === 'ArrowRight' ? 1 : -1)));
      selectTab(next); tabs[next]!.focus();
    };
  });
  for (const radio of surface.querySelectorAll<HTMLInputElement>('[name=themeChoice]')) radio.onchange = () => { if (radio.checked) field('theme').value = radio.value; validate(); };
  el('resetFonts').onclick = () => { field('uiFont').value = ''; validate(); };
  surface.addEventListener('input', validate); surface.addEventListener('change', validate);
  function systemTheme(dark: boolean) { el('systemTheme').textContent = t('settings.system', { value: t(dark ? 'ui.dark' : 'ui.light') }); }
  function report(error: unknown) { el('settingsIssue').textContent = errorText(error); }
  el('settingsButton').onclick = () => { void (async () => {
    const overview = await api.call('overview');
    for (const key of paths) { field(key).value = overview.settings.profile[key] ?? ''; field(key).placeholder = overview.locations[key] ?? t('ui.managed_native_engine'); }
    resourcesBusy = overview.resourcesBusy ?? Boolean(overview.queue?.active); lockResources();
    el('resourceLock').hidden = !resourcesBusy;
    systemTheme(overview.systemDark);
    field('uiFont').value = overview.settings.uiFont ?? ''; field('uiFont').placeholder = defaultFont;
    field('theme').value = overview.settings.theme ?? 'system';
    for (const radio of surface.querySelectorAll<HTMLInputElement>('[name=themeChoice]')) radio.checked = radio.value === field('theme').value;
    selectTab(0);
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
    if (field('uiFont').value.trim()) value.uiFont = field('uiFont').value;
    const submitted = snapshot();
    retry = async () => {
      saving = true;
      const controls = [...surface.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>('input,button,select')];
      controls.forEach(control => { control.disabled = true; });
      try {
        await api.call('preferences', value); initial = submitted; await changed();
        if (snapshot() === submitted) shell.close();
        retry = undefined;
      } finally { saving = false; controls.forEach(control => { control.disabled = false; }); lockResources(); validate(); }
    };
    failedAtClose = false; save = retry(); void save.catch(report);
  };
  return {
    systemTheme,
    async settleSave() {
      // Retry only the explicitly submitted values, never a subsequently edited draft.
      if (failedAtClose && retry) { save = retry(); void save.catch(report); }
      try { await save; failedAtClose = false; }
      catch (error) { failedAtClose = true; throw error; }
    },
    async approveQuit() { return !surface.open || snapshot() === initial || confirmDiscard(); },
  };
}
