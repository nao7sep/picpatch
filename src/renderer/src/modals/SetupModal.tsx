// First-use setup: choose a model, install its engine, then download it (or register
// files already on this computer). Opening or skipping changes nothing; every
// acquisition is its own explicit step. Setup is not a launch gate: PicPatch opens
// sessions without a model, so Skip setup always closes, any step that is running
// carries on in application state, and that step offers its own Cancel.
import { useCallback, useEffect, useRef, useState } from 'react';
import { sameTarget, type ManagedState, type ManagedTarget } from '../../../shared/managed.ts';
import type { Message } from '../../../shared/i18n/index.ts';
import { modelLabel, modelOption, modelSummary, tierOrder } from '../models.ts';
import { api, type CatalogModel, type Engines, type Readiness } from '../api.ts';
import { useI18n } from '../i18n.tsx';
import { resultMessage, runningMessage } from '../managed.ts';
import { Modal } from './Modal.tsx';
import { engineReady, native } from './resources.ts';

const RECOMMENDED = 'flux2-klein-4b-4bit';

export function SetupModal({ models, initial, readiness, managed, onClose, onUse, onManage }: {
  models: readonly CatalogModel[]; initial?: string; readiness: Readiness | undefined; managed: ManagedState;
  onClose: () => void; onUse: (modelId: string) => void; onManage: (modelId: string) => void;
}) {
  const { t, number, errorText } = useI18n();
  const say = (value: Message) => t(value.key, value.values);
  const [choice, setChoice] = useState(initial ?? (models.some(model => model.id === RECOMMENDED) ? RECOMMENDED : models[0]?.id ?? ''));
  // 'failed' means the check could not run: the engine counts as not ready and Install stays available.
  const [engines, setEngines] = useState<Engines | 'failed'>();
  // A request refused before it started; a started step reports through application state.
  const [failure, setFailure] = useState<string>();
  const inspection = useRef(0);
  const { active, last } = managed;
  const busy = Boolean(active);
  const opened = useRef(last?.id ?? 0);
  const failed = last && last.id > opened.current && (last.status === 'failed' || last.status === 'refused') ? last : undefined;
  const model = models.find(item => item.id === choice);
  const ready = readiness?.[choice] === 'ready';
  const hasEngine = engineReady(model, engines === 'failed' ? undefined : engines);

  const inspect = useCallback(async (modelId: string) => {
    const revision = ++inspection.current; setEngines(undefined);
    try { const result = await api.engines(modelId); if (revision === inspection.current) setEngines(result); }
    catch (error) { if (revision === inspection.current) { setEngines('failed'); setFailure(errorText(error)); } }
  }, [errorText]);
  // Engines are read when the view opens, for each choice, and again when a step settles.
  useEffect(() => { if (choice) void inspect(choice); }, [choice, inspect, last?.id]);

  const act = (work: () => Promise<unknown>) => { setFailure(undefined); void work().catch(error => setFailure(errorText(error))); };
  const cancel = () => void api.cancelManaged().catch(error => setFailure(errorText(error)));
  const install = () => act(() => native(model) ? api.installNative(choice) : api.installPython(choice));
  const prepare = () => {
    if (model?.acquisition !== 'pinned') { onManage(choice); return; }
    act(() => api.download(choice));
  };
  /** A step's own running state: its progress and Cancel, in place of its action. */
  const running = (target: ManagedTarget) => sameTarget(active, target) ? (
    <span className="row-running" role="status">
      <span className="task-status">{say(runningMessage(active!))}</span>
      <button type="button" className="button compact" onClick={cancel}>{t('ui.cancel')}</button>
    </span>
  ) : null;
  const engineStep = running({ action: native(model) ? 'installNative' : 'installPython', modelId: choice });
  const prepareStep = running({ action: 'download', modelId: choice });
  // Work that is not one of these steps, such as a download for another model, still shows with its Cancel.
  const other = active && !engineStep && !prepareStep ? running(active) : null;
  // Downloads first, recommended models first within each kind.
  const sorted = [...models].sort((a, b) => Number(b.acquisition === 'pinned') - Number(a.acquisition === 'pinned') || tierOrder[a.profile.tier] - tierOrder[b.profile.tier] || modelLabel(a.id).localeCompare(modelLabel(b.id)));
  const summary = model && modelSummary(model);

  return (
    <Modal title={t('setup.title')} width={560} onClose={onClose} footer={<>
      <span className="spacer" />
      <button type="button" className="button" onClick={onClose}>{t('setup.skip')}</button>
      <button type="button" className="button primary" disabled={busy || !ready} onClick={() => onUse(choice)}>{t('setup.use')}</button>
    </>}>
      <p className="modal-intro">{t('setup.intro')}</p>
      <label className="field">
        <span className="field-label">{t('setup.model')}</span>
        <select value={choice} onChange={event => setChoice(event.target.value)} data-autofocus="true">
          {sorted.map(item => <option key={item.id} value={item.id}>{modelOption(item)}</option>)}
        </select>
        {summary && <span className="field-help">{[summary.purposes, summary.facts].filter(Boolean).join(' — ')}</span>}
        <span className="field-help">{model?.acquisition === 'pinned' ? t('setup.size', { size: `${number(model.downloadBytes / 1e9, { maximumFractionDigits: 1 })} GB` }) : t('setup.local')}</span>
      </label>
      <ol className="steps">
        <li className={hasEngine ? 'done' : undefined}>
          <div className="step-text">
            <span className="step-title">{t('setup.engine')}</span>
            <span className="field-help">{engines ? (hasEngine ? t('status.ready') : t('setup.engineDetail')) : t('model.checking')}</span>
          </div>
          {engineStep ?? <button type="button" className="button" disabled={busy || !engines || hasEngine} onClick={install}>{t('setup.install')}</button>}
        </li>
        <li className={ready ? 'done' : undefined}>
          <div className="step-text">
            <span className="step-title">{t('setup.prepare')}</span>
            <span className="field-help">{ready ? t('status.ready') : model?.acquisition === 'pinned' ? t('setup.prepareDetail') : t('setup.registerDetail')}</span>
          </div>
          {prepareStep ?? <button type="button" className="button" disabled={busy || !hasEngine || ready} onClick={prepare}>{model?.acquisition === 'pinned' ? t('ui.download') : t('setup.register')}</button>}
        </li>
      </ol>
      {other}
      {failure ? <p className="field-error" role="alert">{failure}</p> : failed ? <p className="field-error" role="alert">{say(resultMessage(failed))}</p> : null}
    </Modal>
  );
}
