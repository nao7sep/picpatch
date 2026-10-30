// Managed tools: the engine a model runs on, readiness, download, verification, registration
// of files already on this computer, and removal of managed revisions. Inspection never
// acquires anything; each change is an explicit action. Application state owns every
// operation, so this view only shows it and sends commands: Close always closes, the work
// carries on, and the running row offers its own Cancel.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { sameTarget, type ManagedState, type ManagedTarget } from '../../../shared/managed.ts';
import type { Message } from '../../../shared/i18n/index.ts';
import { resultMessage, runningMessage } from '../managed.ts';
import { controlKinds } from '../../../shared/session.ts';
import { modelLabel, modelOption } from '../models.ts';
import { api, type CatalogModel, type Components, type Engines, type Inventory, type Readiness } from '../api.ts';
import { useI18n } from '../i18n.tsx';
import { fieldProblem, NumberField, NumberFields, type FieldEdit } from '../number-field.tsx';
import { CloseIcon, PlusIcon } from '../components/icons.tsx';
import { Modal } from './Modal.tsx';
import { acceptsLoras, componentFields, engineReady, native, type ComponentKey } from './resources.ts';

type Registration = { directory: string; checkpoint: string; components: Partial<Record<ComponentKey, string>>; controlKind: string; loras: { path: string; scale?: number }[] };
const emptyRegistration = (): Registration => ({ directory: '', checkpoint: '', components: {}, controlKind: 'canny', loras: [] });

export function ManagementModal({ models, initial, nativeExecutable, readiness, managed, onClose }: {
  models: readonly CatalogModel[]; initial?: string; nativeExecutable?: string; readiness: Readiness | undefined; managed: ManagedState; onClose: () => void;
}) {
  const { t, term, number, errorText } = useI18n();
  const say = (value: Message) => t(value.key, value.values);
  const [choice, setChoice] = useState(initial ?? models[0]?.id ?? '');
  const [engines, setEngines] = useState<Engines>();
  const [inventory, setInventory] = useState<Inventory>();
  const [registration, setRegistration] = useState<Registration>(emptyRegistration);
  // Typed LoRA scales, by path; one that is not a number holds Register back.
  const [scaleEdits, setScaleEdits] = useState<Record<string, FieldEdit>>({});
  const scaleFields = useMemo(() => ({ edits: scaleEdits, edit: (id: string, edit: FieldEdit | undefined) => setScaleEdits(value => {
    const next = { ...value }; if (edit) next[id] = edit; else delete next[id]; return next;
  }) }), [scaleEdits]);
  const scaleProblem = fieldProblem(scaleEdits, id => registration.loras.some(lora => lora.path === id));
  // A removed LoRA takes its typed scale with it.
  useEffect(() => setScaleEdits(value => {
    const kept = Object.fromEntries(Object.entries(value).filter(([path]) => registration.loras.some(lora => lora.path === path)));
    return Object.keys(kept).length === Object.keys(value).length ? value : kept;
  }), [registration.loras]);
  const [registering, setRegistering] = useState(false);
  // A request refused before it started; a started operation reports through application state.
  const [failure, setFailure] = useState<string>();
  const inspection = useRef(0);
  const { active, last } = managed;
  const busy = Boolean(active);
  // Results that arrive while this view is open are shown here; an earlier failure stays visible too.
  const opened = useRef(last?.id ?? 0);
  const result = last && (last.id > opened.current || last.status === 'failed' || last.status === 'refused') ? last : undefined;
  const model = models.find(item => item.id === choice);
  const fields = componentFields(model);
  const shownFields = [...fields, ...(Object.keys(registration.components) as ComponentKey[]).filter(key => registration.components[key] && !fields.includes(key))];

  // Engine status follows the selected model's runtime; a reply for an earlier choice is dropped.
  const inspect = useCallback(async (modelId: string) => {
    const revision = ++inspection.current; setEngines(undefined);
    try { const result = await api.engines(modelId); if (revision === inspection.current) setEngines(result); }
    catch (error) { if (revision === inspection.current) setFailure(errorText(error)); }
  }, [errorText, setFailure]);
  const refresh = useCallback(async () => {
    try { setInventory(await api.inventory()); } catch (error) { setFailure(errorText(error)); }
  }, [errorText]);
  // Facts are read when the view opens and again when an operation settles.
  useEffect(() => { void refresh(); }, [refresh, last?.id]);
  useEffect(() => { if (choice) void inspect(choice); }, [choice, inspect, last?.id]);

  const act = (work: () => Promise<unknown>) => {
    setFailure(undefined);
    void work().catch(error => setFailure(errorText(error)));
  };
  const cancel = () => void api.cancelManaged().catch(error => setFailure(errorText(error)));
  /** A row's own running state: its progress and Cancel, in place of its action. */
  const running = (target: ManagedTarget) => sameTarget(active, target) ? (
    <span className="row-running" role="status">
      <span className="task-status">{say(runningMessage(active!))}</span>
      <button type="button" className="button compact" onClick={cancel}>{t('ui.cancel')}</button>
    </span>
  ) : null;

  const register = () => act(() => {
    const components: Components = {};
    for (const key of shownFields) {
      const value = registration.components[key]; if (!value) continue;
      if (key === 'controlNet') components.controlNet = { path: value, kind: registration.controlKind }; else components[key] = value;
    }
    if (registration.loras.length) components.loras = registration.loras;
    return api.register(choice, registration.directory || undefined, registration.checkpoint || undefined, components);
  });
  const pick = async (apply: (path: string) => void, directory = false, current?: string) => {
    try {
      const path = directory ? await api.pickPath(false, registration.directory || undefined) : await api.pickComponent(registration.directory, current);
      if (path) apply(path);
    } catch (error) { setFailure(errorText(error)); }
  };
  const state = readiness?.[choice];
  const engineName = native(model) ? t('management.nativeEngine') : t('management.pythonEngine');
  const engineStatus = !engines ? t('model.checking') : native(model) && nativeExecutable ? t('management.externalEngine') : term('status', (native(model) ? engines.native : engines.python).status);
  const entries = inventory?.entries ?? [];

  // The selected model's actions are one row; whichever of them runs shows there with its Cancel.
  const engineTarget: ManagedTarget = { action: native(model) ? 'installNative' : 'installPython', modelId: choice };
  const rowTargets: ManagedTarget[] = [engineTarget, { action: 'download', modelId: choice }, { action: 'verify', modelId: choice }, { action: 'register', modelId: choice }];
  const rowRunning = rowTargets.map(running).find(Boolean)
    // Work started for another model, or from Setup, shows here too, so it can always be cancelled where it is seen.
    ?? (active && active.action !== 'remove' ? running(active) : null);

  return (
    <Modal title={t('ui.managed_tools_and_models')} width={680} onClose={onClose} footer={<>
      {result && result.status !== 'failed' && result.status !== 'refused' ? <span className="task-status" role="status">{say(resultMessage(result))}</span> : null}
      <span className="spacer" />
      <button type="button" className="button" onClick={onClose}>{t('ui.close')}</button>
    </>}>
      <p className="modal-intro">{t('ui.engines_and_models_are_shared_sdk_resources_sessions_remain')}</p>
      <label className="field">
        <span className="field-label">{t('ui.model')}</span>
        <select value={choice} data-autofocus="true" onChange={event => { setChoice(event.target.value); setRegistration(emptyRegistration()); setRegistering(false); }}>
          {models.map(item => <option key={item.id} value={item.id}>{modelOption(item)}</option>)}
        </select>
      </label>
      <dl className="facts">
        <div><dt>{t('management.state')}</dt><dd>{typeof state === 'object' ? <span className="field-error" role="alert">{say(state.notice)}</span> : t(`model.${state ?? 'checking'}`)}</dd></div>
        <div><dt>{engineName}</dt><dd>{engineStatus}</dd></div>
        {model?.acquisition === 'pinned' ? <div><dt>{t('management.downloadSize')}</dt><dd>{`${number(model.downloadBytes / 1e9, { maximumFractionDigits: 1 })} GB`}</dd></div> : null}
      </dl>
      <div className="button-row">
        {rowRunning ?? <>
          <button type="button" className="button" disabled={busy || !engines || engineReady(model, engines) || (native(model) && Boolean(nativeExecutable))}
            onClick={() => act(() => native(model) ? api.installNative(choice) : api.installPython(choice))}>{t('setup.install')}</button>
          <button type="button" className="button" disabled={busy || model?.acquisition !== 'pinned' || state === 'ready'} onClick={() => act(() => api.download(choice))}>{t('ui.download')}</button>
          <button type="button" className="button" disabled={busy || state !== 'ready'} onClick={() => act(() => api.verify(choice))}>{t('ui.verify_selected_model')}</button>
        </>}
        <button type="button" className="button" aria-expanded={registering} onClick={() => setRegistering(value => !value)}>{t('ui.register_local_bundle')}</button>
      </div>
      <p className="field-help">{t('ui.the_python_setup_tool_is_included_building_python_dependencies')}</p>

      {registering && (
        <section className="settings-group register">
          <h3 className="group-label">{t('ui.local_bundle_and_adapters')}</h3>
          <PathField label={t('ui.bundle_directory')} value={registration.directory} onChoose={() => void pick(path => setRegistration({ ...emptyRegistration(), directory: path }), true)} />
          {native(model) && (
            <PathField label={t('component.checkpoint')} value={registration.checkpoint} disabled={!registration.directory} onChoose={() => void pick(path => setRegistration(value => ({ ...value, checkpoint: path })), false, registration.checkpoint)} />
          )}
          {shownFields.map(key => (
            <PathField key={key} label={t(`component.${key}`)} value={registration.components[key] ?? ''} disabled={!registration.directory}
              note={fields.includes(key) ? undefined : t('management.unused')}
              onChoose={() => void pick(path => setRegistration(value => ({ ...value, components: { ...value.components, [key]: path } })), false, registration.components[key])}
              onClear={() => setRegistration(value => { const components = { ...value.components }; delete components[key]; return { ...value, components }; })}
              extra={key === 'controlNet' ? (
                <select aria-label={t('ui.control_kind')} value={registration.controlKind} onChange={event => setRegistration(value => ({ ...value, controlKind: event.target.value }))}>
                  {controlKinds.map(kind => <option key={kind} value={kind}>{t(`control.${kind}`)}</option>)}
                </select>
              ) : undefined}
            />
          ))}
          {(acceptsLoras(model) || registration.loras.length > 0) && (
            <NumberFields value={scaleFields}><div className="field">
              <span className="field-label">{t('ui.local_loras')}</span>
              {registration.loras.map((lora, index) => (
                <span key={lora.path} className="path-row">
                  <span className="path-value" title={lora.path}>{lora.path}</span>
                  <NumberField id={lora.path} label={t('management.scale', { name: lora.path })} hideLabel className="inline-field" inputClassName="inline-number" placeholder={t('ui.scale_1')}
                    value={lora.scale} rule={{ empty: true }}
                    onCommit={scale => setRegistration(value => ({ ...value, loras: value.loras.map((item, i) => i === index ? (scale === undefined ? { path: item.path } : { ...item, scale }) : item) }))} />
                  <button type="button" className="icon-button" aria-label={t('ui.remove')} title={t('ui.remove')} onClick={() => setRegistration(value => ({ ...value, loras: value.loras.filter((_, i) => i !== index) }))}><CloseIcon /></button>
                </span>
              ))}
              <button type="button" className="button compact" disabled={!registration.directory} onClick={() => void pick(path => setRegistration(value => ({ ...value, loras: [...value.loras, { path }] })))}><PlusIcon /><span>{t('ui.add_lora')}</span></button>
              <span className="field-help">{t('ui.weights_stay_in_the_selected_model_bundle_these_choices')}</span>
            </div></NumberFields>
          )}
          <div className="button-row end">
            <button type="button" className="button primary" disabled={busy || Boolean(scaleProblem) || (native(model) ? !registration.checkpoint : false)} onClick={register}>{t('management.register')}</button>
          </div>
        </section>
      )}

      <section className="settings-group">
        <h3 className="group-label">{t('management.revisions')}</h3>
        {entries.length === 0 ? <p className="field-help">{t('management.noRevisions')}</p> : (
          <ul className="revision-list">
            {entries.map(entry => (
              <li key={`${entry.modelId}:${entry.name}`}>
                <span className="revision-name">{modelLabel(entry.modelId)}</span>
                <span className="revision-meta">{t('management.revision', { revision: entry.name.slice(0, 12), size: number(entry.bytes / 1e9, { maximumFractionDigits: 2 }) })}</span>
                {running({ action: 'remove', modelId: entry.modelId, revision: entry.name })
                  ?? <button type="button" className="button compact outline-danger" disabled={busy} onClick={() => act(() => api.removeManaged(entry.modelId, entry.name))}>{t('ui.remove_revision')}</button>}
              </li>
            ))}
          </ul>
        )}
      </section>
      {failure ? <p className="field-error" role="alert">{failure}</p>
        : result && (result.status === 'failed' || result.status === 'refused') ? <p className="field-error" role="alert">{say(resultMessage(result))}</p> : null}
    </Modal>
  );
}

function PathField({ label, value, note, disabled, extra, onChoose, onClear }: {
  label: string; value: string; note?: string; disabled?: boolean; extra?: React.ReactNode; onChoose: () => void; onClear?: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="field">
      <span className="field-label">{label}</span>
      <span className="path-row">
        <span className={`path-value${value ? '' : ' empty'}`} title={value}>{value || t('ui.not_selected')}</span>
        {extra}
        <button type="button" className="button compact" disabled={disabled} onClick={onChoose}>{t('ui.choose')}</button>
        {onClear && value && <button type="button" className="icon-button" aria-label={t('management.clear', { name: label })} title={t('ui.clear')} onClick={onClear}><CloseIcon /></button>}
      </span>
      {note && <span className="field-warn">{note}</span>}
    </div>
  );
}
