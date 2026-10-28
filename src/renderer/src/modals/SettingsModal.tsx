// Settings: General (appearance, language, interface font) and Resources (where the
// SDK keeps engines and models). A draft until Save; closing a changed draft asks first.
import { useImperativeHandle, useMemo, useRef, useState, type Ref } from 'react';
import { defaultFont } from '../../../shared/appearance.ts';
import { languages, type Language } from '../../../shared/i18n/index.ts';
import { maxModelsKeptLoaded } from '../../../shared/session.ts';
import { systemTimeZone } from '../../../shared/time-zone.ts';
import { api, type Overview, type Preferences } from '../api.ts';
import { useI18n } from '../i18n.tsx';
import { Modal } from './Modal.tsx';

export interface SettingsGuard { approveQuit: () => Promise<boolean>; settleSave: () => Promise<void> }

const PATHS = ['engineDirectory', 'modelsDirectory', 'nativeExecutable'] as const;
type Form = { theme: 'system' | 'light' | 'dark'; language: 'system' | Language; timeZone: string; uiFont: string; modelsKeptLoaded: number } & Record<typeof PATHS[number], string>;

const absolute = (value: string) => !value || (/Win/.test(navigator.platform) ? /^(?:[a-z]:[\\/]|\\\\)/i.test(value) : value.startsWith('/'));

export function SettingsModal({ overview, guard, onClose, onSaved, confirmDiscard }: {
  overview: Overview; guard: Ref<SettingsGuard>; onClose: () => void; onSaved: (overview: Overview) => void; confirmDiscard: (ending?: 'close' | 'quit') => Promise<boolean>;
}) {
  const { t, errorText, number } = useI18n();
  const initial = useRef<Form>({
    theme: overview.settings.theme ?? 'system', language: overview.settings.language ?? 'system', timeZone: overview.settings.timeZone ?? 'system', uiFont: overview.settings.uiFont ?? '', modelsKeptLoaded: overview.settings.modelsKeptLoaded ?? 1,
    engineDirectory: overview.settings.profile.engineDirectory ?? '', modelsDirectory: overview.settings.profile.modelsDirectory ?? '', nativeExecutable: overview.settings.profile.nativeExecutable ?? '',
  });
  const [form, setForm] = useState<Form>(initial.current);
  // Saved and native-selected paths are literal; only authored edits trim surrounding whitespace.
  const authoredPaths = useRef(new Set<typeof PATHS[number]>());
  const pathValue = (key: typeof PATHS[number]) => authoredPaths.current.has(key) ? form[key].trim() : form[key];
  const [tab, setTab] = useState<'general' | 'resources'>('general');
  const [failure, setFailure] = useState<string>();
  const [saving, setSaving] = useState(false);
  const pendingSave = useRef<Promise<void>>(Promise.resolve());
  const failedSubmit = useRef<(() => Promise<void>) | undefined>(undefined);
  const dirty = JSON.stringify(form) !== JSON.stringify(initial.current);
  const invalid = PATHS.filter(key => !absolute(pathValue(key)));
  const locked = overview.resourcesBusy;
  const formRef = useRef(form); formRef.current = form;
  const dirtyRef = useRef(dirty); dirtyRef.current = dirty;

  useImperativeHandle(guard, () => ({
    approveQuit: async () => !dirtyRef.current || confirmDiscard('quit'),
    // Retry only the values that were submitted, never a draft edited since.
    settleSave: async () => { if (failedSubmit.current) await failedSubmit.current(); else await pendingSave.current; },
  }), [confirmDiscard]);

  const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm(value0 => ({ ...value0, [key]: value }));
  const save = () => {
    if (saving || !dirty || invalid.length) return;
    const submitted = form;
    const value: Preferences = {};
    for (const key of PATHS) if (pathValue(key)) value[key] = pathValue(key);
    if (submitted.language !== 'system') value.language = submitted.language;
    if (submitted.theme !== 'system') value.theme = submitted.theme;
    if (submitted.timeZone !== 'system') value.timeZone = submitted.timeZone;
    if (submitted.uiFont.trim()) value.uiFont = submitted.uiFont;
    if (submitted.modelsKeptLoaded !== 1) value.modelsKeptLoaded = submitted.modelsKeptLoaded;
    const attempt = async () => {
      setSaving(true); setFailure(undefined);
      try {
        const next = await api.preferences(value);
        failedSubmit.current = undefined; initial.current = submitted; onSaved(next);
        if (JSON.stringify(formRef.current) === JSON.stringify(submitted)) onClose();
      } catch (error) { failedSubmit.current = attempt; setFailure(errorText(error)); throw error; }
      finally { setSaving(false); }
    };
    pendingSave.current = attempt(); pendingSave.current.catch(() => {});
  };
  const close = async () => { if (saving) return; if (!dirty || await confirmDiscard()) onClose(); };
  const choose = async (key: typeof PATHS[number]) => {
    try {
      const current = pathValue(key);
      const fallback = key === 'nativeExecutable' ? (pathValue('engineDirectory') || overview.resourceDefaults.engineDirectory) : overview.resourceDefaults[key];
      const path = await api.pickPath(key === 'nativeExecutable', (absolute(current) && current) || fallback);
      if (path) { authoredPaths.current.delete(key); set(key, path); }
    }
    catch (error) { setFailure(errorText(error)); }
  };

  // Zones are chosen from the platform's list, never typed; System names the zone it resolves to now.
  const zones = useMemo(() => Intl.supportedValuesOf('timeZone'), []);
  const systemName = new Intl.DisplayNames([document.documentElement.lang || 'en'], { type: 'language' }).of(overview.locale.systemLanguage ?? 'en') ?? '';
  const tabs = ['general', 'resources'] as const;
  return (
    <Modal title={t('ui.settings')} width={600} onClose={() => void close()} guarded={dirty} closeDisabled={saving}
      band={<div className="tab-strip" role="tablist" aria-label={t('ui.settings')} onKeyDown={event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? 1 : Math.max(0, Math.min(1, tabs.indexOf(tab) + (event.key === 'ArrowRight' ? 1 : -1)));
        setTab(tabs[next]!); document.getElementById(`settings-tab-${tabs[next]}`)?.focus();
      }}>
        {tabs.map(name => <button key={name} id={`settings-tab-${name}`} type="button" role="tab" aria-selected={tab === name} tabIndex={tab === name ? 0 : -1} className={tab === name ? 'on' : undefined} onClick={() => setTab(name)}>{t(`settings.${name}`)}</button>)}
      </div>}
      footer={<>
        <span className="spacer" />
        <button type="button" className="button" disabled={saving} onClick={() => void close()}>{t('ui.cancel')}</button>
        <button type="button" className="button primary" disabled={saving || !dirty || invalid.length > 0} onClick={save}>{t('ui.save_settings')}</button>
      </>}
    >
      <fieldset disabled={saving} className="plain">
        {tab === 'general' ? (
          <div role="tabpanel" aria-labelledby="settings-tab-general">
            <section className="settings-group">
              <h3 className="group-label">{t('ui.appearance')}</h3>
              <div className="segmented" role="radiogroup" aria-label={t('ui.appearance')}>
                {(['system', 'light', 'dark'] as const).map(value => (
                  <label key={value} className={form.theme === value ? 'on' : undefined}>
                    <input type="radio" name="theme" checked={form.theme === value} onChange={() => set('theme', value)} />
                    <span>{value === 'system' ? t('settings.system', { value: t(overview.systemDark ? 'ui.dark' : 'ui.light') }) : t(`ui.${value}`)}</span>
                  </label>
                ))}
              </div>
              <label className="field">
                <span className="field-label">{t('settings.language')}</span>
                <select value={form.language} onChange={event => set('language', event.target.value as Form['language'])}>
                  <option value="system">{t('settings.system', { value: systemName })}</option>
                  {languages.map(([tag, name]) => <option key={tag} value={tag} lang={tag}>{name}</option>)}
                </select>
              </label>
              <label className="field">
                <span className="field-label">{t('settings.timeZone')}</span>
                <select value={form.timeZone} onChange={event => set('timeZone', event.target.value)}>
                  <option value="system">{t('settings.system', { value: systemTimeZone() })}</option>
                  {zones.map(zone => <option key={zone} value={zone}>{zone}</option>)}
                </select>
              </label>
            </section>
            <section className="settings-group">
              <div className="group-head">
                <h3 className="group-label">{t('settings.fonts')}</h3>
                <button type="button" className="button compact" disabled={!form.uiFont} onClick={() => set('uiFont', '')}>{t('settings.resetFonts')}</button>
              </div>
              <label className="field">
                <span className="field-label">{t('settings.uiFont')}</span>
                <input type="text" data-autofocus="true" value={form.uiFont} placeholder={defaultFont} onChange={event => set('uiFont', event.target.value)} />
              </label>
            </section>
          </div>
        ) : (
          <div role="tabpanel" aria-labelledby="settings-tab-resources">
            <p className="field-help">{t('ui.empty_resource_paths_use_the_displayed_sdk_default_changing')}</p>
            {locked && <p className="field-warn">{t('settings.locked')}</p>}
            {PATHS.map(key => (
              <label key={key} className="field">
                <span className="field-label">{t(key === 'engineDirectory' ? 'ui.engine_folder' : key === 'modelsDirectory' ? 'ui.models_folder' : 'ui.external_native_executable')}</span>
                <span className="path-row">
                  <input type="text" value={form[key]} disabled={locked} aria-invalid={invalid.includes(key)}
                    placeholder={key === 'nativeExecutable' ? t('ui.managed_native_engine') : overview.resourceDefaults[key] ?? ''} onChange={event => { authoredPaths.current.add(key); set(key, event.target.value); }} />
                  <button type="button" className="button" disabled={locked} onClick={() => void choose(key)}>{t('ui.choose')}</button>
                </span>
              </label>
            ))}
            {invalid.length > 0 && <p className="field-error">{t('error.stored_resource_paths_must_be_absolute')}</p>}
            <label className="field">
              <span className="field-label">{t('settings.modelsKeptLoaded')}</span>
              <select value={form.modelsKeptLoaded} onChange={event => set('modelsKeptLoaded', Number(event.target.value))}>
                {Array.from({ length: maxModelsKeptLoaded }, (_, index) => index + 1).map(count => <option key={count} value={count}>{number(count)}</option>)}
              </select>
              <span className="field-help">{t('settings.modelsKeptLoadedHelp')}</span>
            </label>
            <div className="field">
              <span className="field-label">{t('ui.sessions_2')}</span>
              <span className="path-value" title={overview.locations.sessionsDirectory}>{overview.locations.sessionsDirectory}</span>
              <span className="field-help">{t('settings.collectionHelp')}</span>
            </div>
          </div>
        )}
      </fieldset>
      {failure && <p className="field-error" role="alert">{failure}</p>}
    </Modal>
  );
}

