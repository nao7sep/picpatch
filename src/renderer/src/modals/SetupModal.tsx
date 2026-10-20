// First-use setup: choose a model, install its engine, then download it (or register
// files already on this computer). Opening or skipping changes nothing; every
// acquisition is its own explicit step.
import { useCallback, useEffect, useRef, useState } from 'react';
import { modelLabel, modelOption, modelSummary } from '../models.ts';
import { api, type CatalogModel, type Engines, type Readiness } from '../api.ts';
import { useI18n } from '../i18n.tsx';
import { Modal } from './Modal.tsx';
import { engineReady, native } from './resources.ts';
import { useOperation } from './useOperation.ts';

const RECOMMENDED = 'flux2-klein-4b-4bit';

export function SetupModal({ models, initial, onClose, onChanged, onUse, onManage }: {
  models: readonly CatalogModel[]; initial?: string; onClose: () => void; onChanged: () => Promise<Readiness>;
  onUse: (modelId: string) => void; onManage: (modelId: string) => void;
}) {
  const { t, number, errorText } = useI18n();
  const [readiness, setReadiness] = useState<Readiness>();
  const [choice, setChoice] = useState(initial ?? (models.some(model => model.id === RECOMMENDED) ? RECOMMENDED : models[0]?.id ?? ''));
  // 'failed' means the check could not run: the engine counts as not ready and Install stays available.
  const [engines, setEngines] = useState<Engines | 'failed'>();
  const inspection = useRef(0);
  const { busy, failure, setFailure, run, cancel } = useOperation();
  const model = models.find(item => item.id === choice);
  const ready = readiness?.[choice] === 'ready';
  const hasEngine = engineReady(model, engines === 'failed' ? undefined : engines);

  const inspect = useCallback(async (modelId: string) => {
    const revision = ++inspection.current; setEngines(undefined);
    try { const result = await api.engines(modelId); if (revision === inspection.current) setEngines(result); }
    catch (error) { if (revision === inspection.current) { setEngines('failed'); setFailure(errorText(error)); } }
  }, [setFailure, errorText]);
  useEffect(() => { void api.readiness().then(setReadiness, () => setReadiness({})); }, []);
  useEffect(() => { if (choice) void inspect(choice); }, [choice, inspect]);

  const after = async () => { setReadiness(await onChanged()); await inspect(choice); };
  const install = () => void run(async () => { await (native(model) ? api.installNative(choice) : api.installPython(choice)); await after(); });
  const prepare = () => {
    if (model?.acquisition !== 'pinned') { onManage(choice); return; }
    void run(async () => { const result = await api.download(choice); await after(); return result; });
  };
  // Downloads first, recommended models first within each kind.
  const tier = { recommended: 0, standard: 1, specialist: 2 } as const;
  const sorted = [...models].sort((a, b) => Number(b.acquisition === 'pinned') - Number(a.acquisition === 'pinned') || tier[a.profile.tier] - tier[b.profile.tier] || modelLabel(a.id).localeCompare(modelLabel(b.id)));
  const summary = model && modelSummary(model);

  return (
    <Modal title={t('setup.title')} width={560} guarded={busy} onClose={() => { if (!busy) onClose(); }} footer={<>
      {busy && <span className="task-status">{t('ui.working')}</span>}
      <span className="spacer" />
      {busy ? <button type="button" className="button" onClick={cancel}>{t('ui.cancel_operation')}</button>
        : <button type="button" className="button" onClick={onClose}>{t('setup.skip')}</button>}
      <button type="button" className="button primary" disabled={busy || !ready} onClick={() => onUse(choice)}>{t('setup.use')}</button>
    </>}>
      <p className="modal-intro">{t('setup.intro')}</p>
      <label className="field">
        <span className="field-label">{t('setup.model')}</span>
        <select value={choice} disabled={busy} onChange={event => setChoice(event.target.value)} data-autofocus="true">
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
          <button type="button" className="button" disabled={busy || !engines || hasEngine} onClick={install}>{t('setup.install')}</button>
        </li>
        <li className={ready ? 'done' : undefined}>
          <div className="step-text">
            <span className="step-title">{t('setup.prepare')}</span>
            <span className="field-help">{ready ? t('status.ready') : model?.acquisition === 'pinned' ? t('setup.prepareDetail') : t('setup.registerDetail')}</span>
          </div>
          <button type="button" className="button" disabled={busy || !hasEngine || ready} onClick={prepare}>{model?.acquisition === 'pinned' ? t('ui.download') : t('setup.register')}</button>
        </li>
      </ol>
      {failure && <p className="field-error" role="alert">{failure}</p>}
    </Modal>
  );
}
