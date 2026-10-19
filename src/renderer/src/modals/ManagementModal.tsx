// Models and engines: the engine a model runs on, readiness, download, verification,
// registration of files already on this computer, and removal of managed revisions.
// Inspection never acquires anything; each change is an explicit action.
import { useCallback, useEffect, useRef, useState } from 'react';
import { modelName } from '../../shared/model-name.ts';
import { api, type CatalogModel, type Components, type Engines, type Inventory, type Readiness } from '../api.ts';
import { useI18n } from '../i18n.tsx';
import { CloseIcon, PlusIcon } from '../components/icons.tsx';
import { Modal } from './Modal.tsx';
import { acceptsLoras, componentFields, engineReady, native, type ComponentKey } from './resources.ts';
import { useOperation } from './useOperation.ts';

const CONTROL_KINDS = ['canny', 'depth', 'pose'] as const;
type Registration = { directory: string; checkpoint: string; components: Partial<Record<ComponentKey, string>>; controlKind: string; loras: { path: string; scale?: number }[] };
const emptyRegistration = (): Registration => ({ directory: '', checkpoint: '', components: {}, controlKind: 'canny', loras: [] });

export function ManagementModal({ models, initial, nativeExecutable, onClose, onChanged }: {
  models: readonly CatalogModel[]; initial?: string; nativeExecutable?: string; onClose: () => void; onChanged: () => Promise<Readiness>;
}) {
  const { t, term, number, errorText } = useI18n();
  const [choice, setChoice] = useState(initial ?? models[0]?.id ?? '');
  const [readiness, setReadiness] = useState<Readiness>();
  const [engines, setEngines] = useState<Engines>();
  const [inventory, setInventory] = useState<Inventory>();
  const [registration, setRegistration] = useState<Registration>(emptyRegistration);
  const [registering, setRegistering] = useState(false);
  const [done, setDone] = useState<string>();
  const inspection = useRef(0);
  const { busy, failure, setFailure, run, cancel } = useOperation();
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
    const [state, managed] = await Promise.all([api.readiness().catch(() => ({})), api.inventory().catch(error => { setFailure(errorText(error)); return undefined; })]);
    setReadiness(state); setInventory(managed);
  }, [errorText, setFailure]);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => { if (choice) void inspect(choice); setDone(undefined); }, [choice, inspect]);

  const changed = async (message?: string) => { setReadiness(await onChanged()); await refresh(); await inspect(choice); setDone(message); };
  const act = (work: () => Promise<{ status?: string } | unknown>, message: string) => void run(async () => {
    const result = await work();
    if (result === undefined) return undefined; // declined in main's question, or cancelled picker
    await changed((result as { status?: string })?.status === 'refused' ? undefined : message);
    return result;
  });

  const register = () => act(() => {
    const components: Components = {};
    for (const key of shownFields) {
      const value = registration.components[key]; if (!value) continue;
      if (key === 'controlNet') components.controlNet = { path: value, kind: registration.controlKind }; else components[key] = value;
    }
    if (registration.loras.length) components.loras = registration.loras;
    return api.register(choice, registration.directory || undefined, registration.checkpoint || undefined, components);
  }, t('management.registered'));
  const pick = async (apply: (path: string) => void, directory = false) => {
    try {
      const path = directory ? await api.pickPath(false) : await api.pickComponent(registration.directory);
      if (path) apply(path);
    } catch (error) { setFailure(errorText(error)); }
  };
  const state = readiness?.[choice];
  const engineName = native(model) ? t('management.nativeEngine') : t('management.pythonEngine');
  const engineStatus = !engines ? t('model.checking') : native(model) && nativeExecutable ? t('management.externalEngine') : term('status', (native(model) ? engines.native : engines.python).status);
  const entries = inventory?.entries ?? [];

  return (
    <Modal title={t('ui.managed_tools_and_models')} width={680} guarded={busy} onClose={() => { if (!busy) onClose(); }} footer={<>
      {busy ? <span className="task-status">{t('ui.working')}</span> : done ? <span className="task-status" role="status">{done}</span> : null}
      <span className="spacer" />
      {busy && <button type="button" className="button" onClick={cancel}>{t('ui.cancel_operation')}</button>}
      <button type="button" className="button" disabled={busy} onClick={onClose}>{t('ui.close')}</button>
    </>}>
      <p className="modal-intro">{t('ui.engines_and_models_are_shared_sdk_resources_sessions_remain')}</p>
      <label className="field">
        <span className="field-label">{t('ui.model')}</span>
        <select value={choice} disabled={busy} data-autofocus="true" onChange={event => { setChoice(event.target.value); setRegistration(emptyRegistration()); setRegistering(false); }}>
          {models.map(item => <option key={item.id} value={item.id}>{modelName(item.id)}</option>)}
        </select>
      </label>
      <dl className="facts">
        <div><dt>{t('management.state')}</dt><dd>{t(`model.${state ?? 'checking'}`)}</dd></div>
        <div><dt>{engineName}</dt><dd>{engineStatus}</dd></div>
        {model?.downloadBytes ? <div><dt>{t('management.downloadSize')}</dt><dd>{`${number(model.downloadBytes / 1e9, { maximumFractionDigits: 1 })} GB`}</dd></div> : null}
      </dl>
      <div className="button-row">
        <button type="button" className="button" disabled={busy || !engines || engineReady(model, engines) || (native(model) && Boolean(nativeExecutable))}
          onClick={() => act(() => native(model) ? api.installNative(choice) : api.installPython(choice), t('management.installed'))}>{t('setup.install')}</button>
        <button type="button" className="button" disabled={busy || model?.acquisition !== 'pinned' || state === 'ready'} onClick={() => act(() => api.download(choice), t('management.downloaded'))}>{t('ui.download')}</button>
        <button type="button" className="button" disabled={busy || state !== 'ready'} onClick={() => act(() => api.verify(choice), t('management.verified'))}>{t('ui.verify_selected_model')}</button>
        <button type="button" className="button" disabled={busy} aria-expanded={registering} onClick={() => setRegistering(value => !value)}>{t('ui.register_local_bundle')}</button>
      </div>
      <p className="field-help">{t('ui.the_python_setup_tool_is_included_building_python_dependencies')}</p>

      {registering && (
        <section className="settings-group register">
          <h3 className="group-label">{t('ui.local_bundle_and_adapters')}</h3>
          <PathField label={t('ui.bundle_directory')} value={registration.directory} disabled={busy} onChoose={() => void pick(path => setRegistration({ ...emptyRegistration(), directory: path }), true)} />
          {native(model) && (
            <PathField label={t('component.checkpoint')} value={registration.checkpoint} disabled={busy || !registration.directory} onChoose={() => void pick(path => setRegistration(value => ({ ...value, checkpoint: path })))} />
          )}
          {shownFields.map(key => (
            <PathField key={key} label={t(`component.${key}`)} value={registration.components[key] ?? ''} disabled={busy || !registration.directory}
              note={fields.includes(key) ? undefined : t('management.unused')}
              onChoose={() => void pick(path => setRegistration(value => ({ ...value, components: { ...value.components, [key]: path } })))}
              onClear={() => setRegistration(value => { const components = { ...value.components }; delete components[key]; return { ...value, components }; })}
              extra={key === 'controlNet' ? (
                <select aria-label={t('ui.control_kind')} value={registration.controlKind} onChange={event => setRegistration(value => ({ ...value, controlKind: event.target.value }))}>
                  {CONTROL_KINDS.map(kind => <option key={kind} value={kind}>{t(`control.${kind}`)}</option>)}
                </select>
              ) : undefined}
            />
          ))}
          {(acceptsLoras(model) || registration.loras.length > 0) && (
            <div className="field">
              <span className="field-label">{t('ui.local_loras')}</span>
              {registration.loras.map((lora, index) => (
                <span key={lora.path} className="path-row">
                  <span className="path-value" title={lora.path}>{lora.path}</span>
                  <input type="number" step="any" className="inline-number" placeholder={t('ui.scale_1')} aria-label={t('management.scale', { name: lora.path })} value={lora.scale ?? ''}
                    onChange={event => setRegistration(value => ({ ...value, loras: value.loras.map((item, i) => i === index ? (event.target.value === '' ? { path: item.path } : { ...item, scale: Number(event.target.value) }) : item) }))} />
                  <button type="button" className="icon-button" aria-label={t('ui.remove')} title={t('ui.remove')} onClick={() => setRegistration(value => ({ ...value, loras: value.loras.filter((_, i) => i !== index) }))}><CloseIcon size={14} /></button>
                </span>
              ))}
              <button type="button" className="button compact" disabled={busy || !registration.directory} onClick={() => void pick(path => setRegistration(value => ({ ...value, loras: [...value.loras, { path }] })))}><PlusIcon size={14} /><span>{t('ui.add_lora')}</span></button>
              <span className="field-help">{t('ui.weights_stay_in_the_selected_model_bundle_these_choices')}</span>
            </div>
          )}
          <div className="button-row end">
            <button type="button" className="button primary" disabled={busy || (native(model) ? !registration.checkpoint : false)} onClick={register}>{t('management.register')}</button>
          </div>
        </section>
      )}

      <section className="settings-group">
        <h3 className="group-label">{t('management.revisions')}</h3>
        {entries.length === 0 ? <p className="field-help">{t('management.noRevisions')}</p> : (
          <ul className="revision-list">
            {entries.map(entry => (
              <li key={`${entry.modelId}:${entry.name}`}>
                <span className="revision-name">{modelName(entry.modelId)}</span>
                <span className="revision-meta">{t('management.revision', { revision: entry.name.slice(0, 12), size: number(entry.bytes / 1e9, { maximumFractionDigits: 2 }) })}</span>
                <button type="button" className="button compact outline-danger" disabled={busy} onClick={() => act(() => api.removeManaged(entry.modelId, entry.name), t('management.removed'))}>{t('ui.remove_revision')}</button>
              </li>
            ))}
          </ul>
        )}
      </section>
      {failure && <p className="field-error" role="alert">{failure}</p>}
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
        {onClear && value && <button type="button" className="icon-button" aria-label={t('management.clear', { name: label })} title={t('ui.clear')} onClick={onClear}><CloseIcon size={14} /></button>}
      </span>
      {note && <span className="field-warn">{note}</span>}
    </div>
  );
}
